import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import s3Client from '../config/s3.js';
import redis from '../config/redis.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const PRESIGNED_URL_EXPIRY = parseInt(process.env.PRESIGNED_URL_EXPIRY) || 3600;
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8000';

// Initiate upload - generate presigned URLs for chunks
export const initiateUpload = async (req, res) => {
  try {
    const { fileName, fileSize, chunkCount } = req.body;

    if (!fileName || !fileSize || !chunkCount) {
      return res.status(400).json({
        success: false,
        message: 'fileName, fileSize, and chunkCount are required',
      });
    }

    const videoId = uuidv4();
    const uploadUrls = [];

    // Generate presigned URLs for each chunk
    for (let i = 0; i < chunkCount; i++) {
      const key = `videos/${videoId}/chunks/chunk_${String(i).padStart(3, '0')}.mp4`;

      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        ContentType: 'video/mp4',
      });

      const presignedUrl = await getSignedUrl(s3Client, command, {
        expiresIn: PRESIGNED_URL_EXPIRY,
      });

      uploadUrls.push({
        chunkIndex: i,
        uploadUrl: presignedUrl,
        s3Key: key,
      });
    }

    // Store upload session in Redis
    const uploadSession = {
      videoId,
      fileName,
      fileSize,
      totalChunks: chunkCount,
      completedChunks: [],
      chunkUrls: {},
      status: 'uploading',
      createdAt: new Date().toISOString(),
    };

    await redis.setex(
      `upload:${videoId}`,
      7200, // 2 hours expiry
      JSON.stringify(uploadSession)
    );

    res.json({
      success: true,
      videoId,
      uploadUrls,
    });
  } catch (error) {
    console.error('Error initiating upload:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to initiate upload',
      error: error.message,
    });
  }
};

// Track upload progress for resumability
export const trackProgress = async (req, res) => {
  try {
    const { videoId, chunkIndex, status } = req.body;

    if (!videoId || chunkIndex === undefined || !status) {
      return res.status(400).json({
        success: false,
        message: 'videoId, chunkIndex, and status are required',
      });
    }

    const sessionData = await redis.get(`upload:${videoId}`);
    if (!sessionData) {
      return res.status(404).json({
        success: false,
        message: 'Upload session not found',
      });
    }

    const uploadSession = JSON.parse(sessionData);

    if (status === 'completed' && !uploadSession.completedChunks.includes(chunkIndex)) {
      uploadSession.completedChunks.push(chunkIndex);
      uploadSession.completedChunks.sort((a, b) => a - b);

      // Store the S3 key for this chunk
      const s3Key = `videos/${videoId}/chunks/chunk_${String(chunkIndex).padStart(3, '0')}.mp4`;
      uploadSession.chunkUrls[chunkIndex] = s3Key;
    }

    await redis.setex(
      `upload:${videoId}`,
      7200,
      JSON.stringify(uploadSession)
    );

    res.json({
      success: true,
      completedChunks: uploadSession.completedChunks,
      totalChunks: uploadSession.totalChunks,
      progress: `${uploadSession.completedChunks.length}/${uploadSession.totalChunks}`,
    });
  } catch (error) {
    console.error('Error tracking progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to track progress',
      error: error.message,
    });
  }
};

// Get upload status (for resumability)
export const getUploadStatus = async (req, res) => {
  try {
    const { videoId } = req.params;

    const sessionData = await redis.get(`upload:${videoId}`);
    if (!sessionData) {
      return res.status(404).json({
        success: false,
        message: 'Upload session not found',
      });
    }

    const uploadSession = JSON.parse(sessionData);

    const remainingChunks = [];
    for (let i = 0; i < uploadSession.totalChunks; i++) {
      if (!uploadSession.completedChunks.includes(i)) {
        remainingChunks.push(i);
      }
    }

    res.json({
      success: true,
      videoId: uploadSession.videoId,
      fileName: uploadSession.fileName,
      status: uploadSession.status,
      completedChunks: uploadSession.completedChunks,
      remainingChunks,
      totalChunks: uploadSession.totalChunks,
      progress: `${uploadSession.completedChunks.length}/${uploadSession.totalChunks}`,
    });
  } catch (error) {
    console.error('Error getting upload status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get upload status',
      error: error.message,
    });
  }
};

// Complete upload and trigger analysis
export const completeUpload = async (req, res) => {
  try {
    const { videoId } = req.body;

    if (!videoId) {
      return res.status(400).json({
        success: false,
        message: 'videoId is required',
      });
    }

    const sessionData = await redis.get(`upload:${videoId}`);
    if (!sessionData) {
      return res.status(404).json({
        success: false,
        message: 'Upload session not found',
      });
    }

    const uploadSession = JSON.parse(sessionData);

    // Verify all chunks are uploaded
    if (uploadSession.completedChunks.length !== uploadSession.totalChunks) {
      return res.status(400).json({
        success: false,
        message: 'Not all chunks are uploaded',
        completedChunks: uploadSession.completedChunks.length,
        totalChunks: uploadSession.totalChunks,
      });
    }

    // Update status to analyzing
    uploadSession.status = 'analyzing';
    await redis.setex(
      `upload:${videoId}`,
      7200,
      JSON.stringify(uploadSession)
    );

    // Prepare S3 URLs for FastAPI
    const s3Urls = [];
    for (let i = 0; i < uploadSession.totalChunks; i++) {
      const s3Url = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${uploadSession.chunkUrls[i]}`;
      s3Urls.push(s3Url);
    }

    console.log(`🚀 Sending ${s3Urls.length} chunks to FastAPI for analysis...`);

    // Call FastAPI backend with S3 URLs
    // Using FormData format as specified: files - s3URL, files - s3URL, ...
    const formData = new FormData();
    s3Urls.forEach((url) => {
      formData.append('files', url);
    });

    let analysisResults;
    try {
      const response = await axios.post(
        `${FASTAPI_URL}/api/v1/batch/analyze-batch`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          timeout: 0, // No timeout - wait as long as needed
        }
      );
      analysisResults = response.data;
      console.log('✅ Analysis completed successfully');
    } catch (analysisError) {
      console.error('❌ FastAPI analysis error:', analysisError.message);
      
      // Update status to failed
      uploadSession.status = 'failed';
      uploadSession.error = analysisError.message;
      await redis.setex(
        `upload:${videoId}`,
        7200,
        JSON.stringify(uploadSession)
      );

      return res.status(500).json({
        success: false,
        message: 'Analysis failed',
        error: analysisError.message,
      });
    }

    // Generate presigned URL for video playback (first chunk or you can combine)
    // For playback, we'll use the first chunk as demo (in production, you'd combine chunks)
    const playbackKey = uploadSession.chunkUrls[0];
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: playbackKey,
    });

    const videoPlaybackUrl = await getSignedUrl(s3Client, getCommand, {
      expiresIn: 86400, // 24 hours for playback
    });

    // Update status to completed
    uploadSession.status = 'completed';
    uploadSession.analysisResults = analysisResults;
    uploadSession.completedAt = new Date().toISOString();
    await redis.setex(
      `upload:${videoId}`,
      7200,
      JSON.stringify(uploadSession)
    );

    res.json({
      success: true,
      videoId,
      status: 'completed',
      analysisResults,
      videoPlaybackUrl,
      message: 'Upload and analysis completed successfully',
    });
  } catch (error) {
    console.error('Error completing upload:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to complete upload',
      error: error.message,
    });
  }
};
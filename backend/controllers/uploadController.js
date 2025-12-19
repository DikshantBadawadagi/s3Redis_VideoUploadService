import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import s3Client from '../config/s3.js';
import redis from '../config/redis.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const PRESIGNED_URL_EXPIRY = parseInt(process.env.PRESIGNED_URL_EXPIRY) || 3600;
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8000';
const TEMP_DIR = path.join(__dirname, '../../temp');

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Initiate upload - generate presigned URL for full video upload
export const initiateUpload = async (req, res) => {
  try {
    const { fileName, fileSize } = req.body;

    if (!fileName || !fileSize) {
      return res.status(400).json({
        success: false,
        message: 'fileName and fileSize are required',
      });
    }

    const videoId = uuidv4();
    const key = `videos/${videoId}/original/${fileName}`;

    // Generate presigned URL for uploading the full video
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: 'video/mp4',
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGNED_URL_EXPIRY,
    });

    // Store upload session in Redis
    const uploadSession = {
      videoId,
      fileName,
      fileSize,
      originalKey: key,
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
      uploadUrl,
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

// Process video - download, chunk with FFmpeg, upload chunks to S3
export const processVideo = async (req, res) => {
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

    // Update status
    uploadSession.status = 'processing';
    await redis.setex(`upload:${videoId}`, 7200, JSON.stringify(uploadSession));

    console.log(`🎬 Starting video processing for ${videoId}...`);

    // 1. Download video from S3 to temp directory
    const originalKey = uploadSession.originalKey;
    const tempInputPath = path.join(TEMP_DIR, `${videoId}_input.mp4`);
    
    console.log(`📥 Downloading video from S3...`);
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: originalKey,
    });

    const s3Response = await s3Client.send(getCommand);
    const videoStream = s3Response.Body;
    
    // Write to temp file
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(tempInputPath);
      videoStream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    console.log(`✅ Video downloaded: ${tempInputPath}`);

    // 2. Get video duration using FFprobe
    const durationCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempInputPath}"`;
    const durationOutput = execSync(durationCmd).toString().trim();
    const totalDuration = parseFloat(durationOutput);
    console.log(`📊 Video duration: ${totalDuration} seconds`);

    // 3. Chunk video using FFmpeg (segment at 120 seconds, ~2 minutes)
    const chunkDuration = 120; // 2 minutes
    const chunksDir = path.join(TEMP_DIR, videoId);
    
    if (!fs.existsSync(chunksDir)) {
      fs.mkdirSync(chunksDir, { recursive: true });
    }

    console.log(`✂️  Chunking video with FFmpeg (${chunkDuration}s segments)...`);
    
    const chunkPattern = path.join(chunksDir, 'chunk_%03d.mp4');
    
    // FFmpeg command: segment video at keyframes, each chunk is valid MP4
    const ffmpegCmd = `ffmpeg -i "${tempInputPath}" \
      -c copy \
      -f segment \
      -segment_time ${chunkDuration} \
      -reset_timestamps 1 \
      -map 0 \
      "${chunkPattern}"`;

    execSync(ffmpegCmd, { stdio: 'inherit' });

    console.log(`✅ Video chunked successfully`);

    // 4. Get list of chunk files
    const chunkFiles = fs.readdirSync(chunksDir)
      .filter(f => f.startsWith('chunk_') && f.endsWith('.mp4'))
      .sort();

    console.log(`📦 Created ${chunkFiles.length} chunks`);

    // 5. Upload each chunk to S3
    const chunkS3Keys = [];
    const chunkPresignedUrls = [];

    for (let i = 0; i < chunkFiles.length; i++) {
      const chunkFile = chunkFiles[i];
      const chunkPath = path.join(chunksDir, chunkFile);
      const chunkKey = `videos/${videoId}/chunks/${chunkFile}`;

      console.log(`📤 Uploading chunk ${i + 1}/${chunkFiles.length}: ${chunkFile}`);

      // Read chunk file
      const chunkBuffer = fs.readFileSync(chunkPath);

      // Upload to S3
      const putCommand = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: chunkKey,
        Body: chunkBuffer,
        ContentType: 'video/mp4',
      });

      await s3Client.send(putCommand);

      // Generate presigned URL for this chunk (for FastAPI)
      const getCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: chunkKey,
      });

      const presignedUrl = await getSignedUrl(s3Client, getCommand, {
        expiresIn: 3600, // 1 hour
      });

      chunkS3Keys.push(chunkKey);
      chunkPresignedUrls.push(presignedUrl);

      console.log(`✅ Chunk ${i + 1} uploaded: ${chunkKey}`);
    }

    // 6. Clean up temp files
    console.log(`🧹 Cleaning up temp files...`);
    fs.unlinkSync(tempInputPath);
    chunkFiles.forEach(f => {
      fs.unlinkSync(path.join(chunksDir, f));
    });
    fs.rmdirSync(chunksDir);

    // 7. Update session with chunk info
    uploadSession.status = 'chunked';
    uploadSession.totalChunks = chunkFiles.length;
    uploadSession.chunkKeys = chunkS3Keys;
    uploadSession.chunkUrls = chunkPresignedUrls;
    uploadSession.processedAt = new Date().toISOString();

    await redis.setex(`upload:${videoId}`, 7200, JSON.stringify(uploadSession));

    console.log(`✅ Video processing complete: ${chunkFiles.length} chunks ready`);

    res.json({
      success: true,
      videoId,
      totalChunks: chunkFiles.length,
      chunkUrls: chunkPresignedUrls,
      message: `Video chunked into ${chunkFiles.length} valid MP4 segments`,
    });
  } catch (error) {
    console.error('Error processing video:', error);
    
    // Update status to failed
    try {
      const sessionData = await redis.get(`upload:${req.body.videoId}`);
      if (sessionData) {
        const uploadSession = JSON.parse(sessionData);
        uploadSession.status = 'failed';
        uploadSession.error = error.message;
        await redis.setex(`upload:${req.body.videoId}`, 7200, JSON.stringify(uploadSession));
      }
    } catch (redisError) {
      console.error('Failed to update Redis:', redisError);
    }

    res.status(500).json({
      success: false,
      message: 'Failed to process video',
      error: error.message,
    });
  }
};

// Trigger analysis with FastAPI
export const analyzeVideo = async (req, res) => {
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

    if (uploadSession.status !== 'chunked') {
      return res.status(400).json({
        success: false,
        message: 'Video not yet chunked',
        currentStatus: uploadSession.status,
      });
    }

    // Update status
    uploadSession.status = 'analyzing';
    await redis.setex(`upload:${videoId}`, 7200, JSON.stringify(uploadSession));

    const chunkUrls = uploadSession.chunkUrls;

    console.log(`🚀 Sending ${chunkUrls.length} chunk URLs to FastAPI for analysis...`);

    let analysisResults;
    try {
      // Option 1: Send URLs as JSON (if FastAPI accepts URLs)
      // Uncomment and test:
      // const response = await axios.post(
      //   `${FASTAPI_URL}/api/v1/batch/analyze-batch`,
      //   {
      //     files: chunkUrls,  // Array of URLs
      //   },
      //   {
      //     headers: {
      //       'Content-Type': 'application/json',
      //     },
      //     timeout: 0,
      //   }
      // );

      // Option 2: Download chunks and send as actual file uploads
      // If your FastAPI expects actual file data (not URLs):
      
      const formData = new FormData();
      
      for (let i = 0; i < chunkUrls.length; i++) {
        console.log(`📥 Downloading chunk ${i + 1} for FastAPI...`);
        const response = await axios.get(chunkUrls[i], { responseType: 'arraybuffer' });
        const blob = new Blob([response.data], { type: 'video/mp4' });
        formData.append('files', blob, `chunk_${String(i).padStart(3, '0')}.mp4`);
      }

      const response = await axios.post(
        `${FASTAPI_URL}/api/v1/batch/analyze-batch`,
        formData,
        {
          headers: {
            'Content-Type': 'multipart/form-data',
          },
          timeout: 0,
        }
      );
      

      analysisResults = response.data;

      // Simulated response for now
      // analysisResults = {
      //   message: 'Analysis simulated successfully',
      //   chunksProcessed: chunkUrls.length,
      //   note: 'All chunks are valid MP4 files with correct metadata!',
      //   urls: chunkUrls,
      // };

      console.log('✅ Analysis completed successfully');
    } catch (analysisError) {
      console.error('❌ FastAPI analysis error:', analysisError.message);

      uploadSession.status = 'failed';
      uploadSession.error = analysisError.message;
      await redis.setex(`upload:${videoId}`, 7200, JSON.stringify(uploadSession));

      return res.status(500).json({
        success: false,
        message: 'Analysis failed',
        error: analysisError.message,
      });
    }

    // Update session with results
    uploadSession.status = 'completed';
    uploadSession.analysisResults = analysisResults;
    uploadSession.completedAt = new Date().toISOString();
    await redis.setex(`upload:${videoId}`, 7200, JSON.stringify(uploadSession));

    res.json({
      success: true,
      videoId,
      status: 'completed',
      analysisResults,
      message: 'Analysis completed successfully',
    });
  } catch (error) {
    console.error('Error analyzing video:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to analyze video',
      error: error.message,
    });
  }
};

// Get chunk URLs for playback
export const getChunks = async (req, res) => {
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

    if (!uploadSession.chunkUrls || uploadSession.chunkUrls.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Video not yet chunked',
        status: uploadSession.status,
      });
    }

    // Generate fresh presigned URLs for playback (24h expiry)
    const chunkUrls = [];
    for (const chunkKey of uploadSession.chunkKeys) {
      const getCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: chunkKey,
      });

      const presignedUrl = await getSignedUrl(s3Client, getCommand, {
        expiresIn: 86400, // 24 hours
      });

      chunkUrls.push(presignedUrl);
    }

    res.json({
      success: true,
      videoId,
      totalChunks: chunkUrls.length,
      chunkUrls,
      message: 'Chunk URLs ready for playback',
    });
  } catch (error) {
    console.error('Error getting chunks:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get chunks',
      error: error.message,
    });
  }
};

// Get upload status
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

    res.json({
      success: true,
      videoId: uploadSession.videoId,
      fileName: uploadSession.fileName,
      status: uploadSession.status,
      totalChunks: uploadSession.totalChunks || 0,
      createdAt: uploadSession.createdAt,
      processedAt: uploadSession.processedAt,
      completedAt: uploadSession.completedAt,
    });
  } catch (error) {
    console.error('Error getting status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get status',
      error: error.message,
    });
  }
};

// Stream video - concatenate all chunks and stream to client
export const streamVideo = async (req, res) => {
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

    if (!uploadSession.fileName) {
      return res.status(400).json({
        success: false,
        message: 'Original video fileName not found in session',
      });
    }

    // Generate presigned URL for the original video in S3
    const originalKey = `videos/${videoId}/original/${uploadSession.fileName}`;
    
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: originalKey,
    });

    const presignedUrl = await getSignedUrl(s3Client, getCommand, {
      expiresIn: 86400, // 24 hours for playback
    });

    res.json({
      success: true,
      videoId,
      playbackUrl: presignedUrl,
      fileName: uploadSession.fileName,
      fileSize: uploadSession.fileSize,
      message: 'Presigned URL for original video',
    });
  } catch (error) {
    console.error('Error getting playback URL:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get playback URL',
      error: error.message,
    });
  }
};
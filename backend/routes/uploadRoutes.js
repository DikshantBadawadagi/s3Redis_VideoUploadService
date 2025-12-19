import express from 'express';
import {
  initiateUpload,
  processVideo,
  analyzeVideo,
  getChunks,
  getUploadStatus,
  streamVideo,
} from '../controllers/uploadController.js';

const router = express.Router();

// Step 1: Initiate upload - get presigned URL for full video upload
router.post('/initiate', initiateUpload);

// Step 2: Process video - download, chunk with FFmpeg, upload chunks
router.post('/process', processVideo);

// Step 3: Analyze video - send chunk URLs to FastAPI
router.post('/analyze', analyzeVideo);

// Get chunk URLs for playback
router.get('/chunks/:videoId', getChunks);

// Get upload status
router.get('/status/:videoId', getUploadStatus);

// Stream video - server-side stitching (recommended for playback)
router.get('/playback/:videoId', streamVideo);

export default router;
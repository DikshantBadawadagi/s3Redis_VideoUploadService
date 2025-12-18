import express from 'express';
import {
  initiateUpload,
  trackProgress,
  getUploadStatus,
  completeUpload,
} from '../controllers/uploadController.js';

const router = express.Router();

// Initiate upload - get presigned URLs
router.post('/initiate', initiateUpload);

// Track chunk upload progress
router.post('/progress', trackProgress);

// Get upload status (for resumability)
router.get('/status/:videoId', getUploadStatus);

// Complete upload and trigger analysis
router.post('/complete', completeUpload);

export default router;
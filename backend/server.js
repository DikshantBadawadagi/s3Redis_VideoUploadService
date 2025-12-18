import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import uploadRoutes from './routes/uploadRoutes.js';
import redis from './config/redis.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/upload', uploadRoutes);

// Health check
app.get('/health', async (req, res) => {
  try {
    await redis.ping();
    res.json({
      success: true,
      message: 'Server is healthy',
      redis: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Server is unhealthy',
      redis: 'disconnected',
      error: error.message,
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Video Upload Service API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      initiateUpload: 'POST /api/upload/initiate',
      trackProgress: 'POST /api/upload/progress',
      getStatus: 'GET /api/upload/status/:videoId',
      completeUpload: 'POST /api/upload/complete',
    },
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: err.message,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   🚀 Video Upload Service Started         ║
║                                            ║
║   Port: ${PORT}                              ║
║   Environment: ${process.env.NODE_ENV || 'development'}            ║
║   S3 Bucket: ${process.env.S3_BUCKET_NAME || 'Not configured'}        ║
║   Redis: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || '6379'}                ║
║   FastAPI: ${process.env.FASTAPI_URL || 'http://localhost:8000'}       ║
║                                            ║
║   API Docs: http://localhost:${PORT}        ║
╚════════════════════════════════════════════╝
  `);
});

export default app;
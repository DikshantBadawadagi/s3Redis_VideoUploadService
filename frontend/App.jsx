import { useState } from 'react';
import axios from 'axios';

const CHUNK_SIZE = 75 * 1024 * 1024; // 75 MB per chunk (approx 2 mins of 720p video)
const API_BASE_URL = 'http://localhost:3000/api';

function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [analysisResults, setAnalysisResults] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [error, setError] = useState(null);
  const [videoId, setVideoId] = useState(null);

  // Handle file selection
  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file && file.type.startsWith('video/')) {
      setSelectedFile(file);
      setError(null);
      setAnalysisResults(null);
      setVideoUrl(null);
      setProgress(0);
    } else {
      setError('Please select a valid video file');
    }
  };

  // Split file into chunks
  const splitFileIntoChunks = (file) => {
    const chunks = [];
    let offset = 0;

    while (offset < file.size) {
      const chunk = file.slice(offset, offset + CHUNK_SIZE);
      chunks.push(chunk);
      offset += CHUNK_SIZE;
    }

    return chunks;
  };

  // Upload video with chunking and resumability
  const handleUpload = async () => {
    if (!selectedFile) {
      setError('Please select a video file first');
      return;
    }

    try {
      setUploading(true);
      setError(null);
      setUploadStatus('Preparing upload...');

      // Split file into chunks
      const chunks = splitFileIntoChunks(selectedFile);
      const chunkCount = chunks.length;

      console.log(`📦 Split video into ${chunkCount} chunks (${CHUNK_SIZE / (1024 * 1024)} MB each)`);

      // Step 1: Initiate upload - get presigned URLs
      setUploadStatus('Getting upload URLs...');
      const initiateResponse = await axios.post(`${API_BASE_URL}/upload/initiate`, {
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        chunkCount: chunkCount,
      });

      const { videoId: newVideoId, uploadUrls } = initiateResponse.data;
      setVideoId(newVideoId);
      console.log(`🆔 Video ID: ${newVideoId}`);

      // Step 2: Upload chunks to S3
      setUploadStatus('Uploading chunks to S3...');
      let uploadedChunks = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const { uploadUrl } = uploadUrls[i];

        try {
          // Upload chunk directly to S3 using presigned URL
          await axios.put(uploadUrl, chunk, {
            headers: {
              'Content-Type': 'video/mp4',
            },
            onUploadProgress: (progressEvent) => {
              const chunkProgress = (progressEvent.loaded / progressEvent.total) * 100;
              const totalProgress = ((uploadedChunks + chunkProgress / 100) / chunkCount) * 100;
              setProgress(Math.round(totalProgress));
            },
          });

          uploadedChunks++;
          const overallProgress = (uploadedChunks / chunkCount) * 100;
          setProgress(Math.round(overallProgress));

          // Track progress in Redis for resumability
          await axios.post(`${API_BASE_URL}/upload/progress`, {
            videoId: newVideoId,
            chunkIndex: i,
            status: 'completed',
          });

          console.log(`✅ Chunk ${i + 1}/${chunkCount} uploaded`);
          setUploadStatus(`Uploaded ${uploadedChunks}/${chunkCount} chunks`);
        } catch (uploadError) {
          console.error(`❌ Failed to upload chunk ${i}:`, uploadError);
          throw new Error(`Failed to upload chunk ${i + 1}`);
        }
      }

      console.log('✅ All chunks uploaded successfully');
      setUploading(false);
      setUploadStatus('Upload complete! Starting analysis...');
      setAnalyzing(true);

      // Step 3: Complete upload and trigger analysis
      const completeResponse = await axios.post(`${API_BASE_URL}/upload/complete`, {
        videoId: newVideoId,
      });

      const { analysisResults: results, videoPlaybackUrl } = completeResponse.data;

      console.log('✅ Analysis completed');
      setAnalysisResults(results);
      setVideoUrl(videoPlaybackUrl);
      setAnalyzing(false);
      setUploadStatus('Analysis complete!');
    } catch (err) {
      console.error('Upload error:', err);
      setError(err.response?.data?.message || err.message || 'Upload failed');
      setUploading(false);
      setAnalyzing(false);
    }
  };

  return (
    <div className="app">
      <div className="header">
        <h1>🎥 Video Upload & Analysis</h1>
        <p>Upload your video for AI-powered analysis</p>
      </div>

      {/* File Upload Section */}
      <div className="upload-section">
        <div className="file-input-container">
          <label htmlFor="video-input" className="file-label">
            <h3>📁 Select Video File</h3>
            <p>Click to browse or drag and drop</p>
          </label>
          <input
            id="video-input"
            type="file"
            accept="video/*"
            onChange={handleFileSelect}
            disabled={uploading || analyzing}
          />
        </div>

        {selectedFile && (
          <div className="selected-file">
            <h4>Selected File:</h4>
            <p><strong>Name:</strong> {selectedFile.name}</p>
            <p><strong>Size:</strong> {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB</p>
            <p><strong>Type:</strong> {selectedFile.type}</p>
            <p><strong>Estimated Chunks:</strong> {Math.ceil(selectedFile.size / CHUNK_SIZE)}</p>
          </div>
        )}

        <button
          className="upload-button"
          onClick={handleUpload}
          disabled={!selectedFile || uploading || analyzing}
        >
          {uploading ? 'Uploading...' : analyzing ? 'Analyzing...' : 'Upload & Analyze'}
        </button>
      </div>

      {/* Progress Section */}
      {(uploading || analyzing) && (
        <div className="progress-section">
          {uploading && (
            <>
              <div className="progress-bar-container">
                <div className="progress-bar" style={{ width: `${progress}%` }}>
                  {progress}%
                </div>
              </div>
              <div className="progress-info">
                <p>{uploadStatus}</p>
              </div>
            </>
          )}

          {analyzing && (
            <div className="spinner">
              <div className="spinner-animation"></div>
              <p>🔍 Analyzing video... This may take up to 5 minutes.</p>
              <p style={{ color: '#999', fontSize: '0.9rem', marginTop: '10px' }}>
                Please wait, do not close this page.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="error-message">
          <h3>❌ Error</h3>
          <p>{error}</p>
        </div>
      )}

      {/* Success Message */}
      {analysisResults && !analyzing && (
        <div className="success-message">
          <h3>✅ Success</h3>
          <p>Video uploaded and analyzed successfully!</p>
        </div>
      )}

      {/* Analysis Results */}
      {analysisResults && (
        <div className="results-section">
          <h2>📊 Analysis Results</h2>
          <div className="results-content">
            <pre>{JSON.stringify(analysisResults, null, 2)}</pre>
          </div>
        </div>
      )}

      {/* Video Player */}
      {videoUrl && (
        <div className="video-player-section">
          <h2>▶️ Video Playback</h2>
          <div className="video-container">
            <video controls src={videoUrl}>
              Your browser does not support the video tag.
            </video>
          </div>
          <p style={{ textAlign: 'center', marginTop: '10px', color: '#999', fontSize: '0.9rem' }}>
            Note: Playing first chunk as demo. In production, all chunks would be combined.
          </p>
        </div>
      )}
    </div>
  );
}

export default App;
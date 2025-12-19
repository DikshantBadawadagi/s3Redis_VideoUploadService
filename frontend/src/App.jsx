import { useState, useRef } from 'react';
import axios from 'axios';

const API_BASE_URL = 'http://localhost:3000/api';

function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [analysisResults, setAnalysisResults] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [error, setError] = useState(null);
  const [videoId, setVideoId] = useState(null);
  const [chunkCount, setChunkCount] = useState(0);
  const videoRef = useRef(null);

  // Handle file selection
  const handleFileSelect = (event) => {
    const file = event.target.files[0];
    if (file && file.type.startsWith('video/')) {
      setSelectedFile(file);
      setError(null);
      setAnalysisResults(null);
      setVideoUrl(null);
      setProgress(0);
      setUploadStatus('');
      setChunkCount(0);
    } else {
      setError('Please select a valid video file');
    }
  };

  // Fetch and stitch chunks into a playable blob
  const stitchChunksForPlayback = async (chunkUrlsArray) => {
    try {
      setUploadStatus('Preparing video for playback...');
      
      const chunks = [];
      
      // Fetch all chunks
      for (let i = 0; i < chunkUrlsArray.length; i++) {
        console.log(`📥 Downloading chunk ${i + 1}/${chunkUrlsArray.length}...`);
        const response = await fetch(chunkUrlsArray[i]);
        if (!response.ok) {
          throw new Error(`Failed to fetch chunk ${i}`);
        }
        const blob = await response.blob();
        chunks.push(blob);
        
        // Update progress
        const downloadProgress = 90 + ((i + 1) / chunkUrlsArray.length) * 10;
        setProgress(Math.round(downloadProgress));
      }
      
      // Concatenate all chunks into single blob
      const stitchedBlob = new Blob(chunks, { type: 'video/mp4' });
      const blobUrl = URL.createObjectURL(stitchedBlob);
      
      console.log(`✅ Video stitched successfully: ${(stitchedBlob.size / (1024 * 1024)).toFixed(2)} MB`);
      setUploadStatus('Video ready for playback!');
      return blobUrl;
    } catch (err) {
      console.error('Error stitching chunks:', err);
      throw err;
    }
  };

  // Upload and process video
  const handleUpload = async () => {
    if (!selectedFile) {
      setError('Please select a video file first');
      return;
    }

    try {
      setError(null);
      
      // Step 1: Initiate upload
      setUploading(true);
      setUploadStatus('Getting upload URL...');
      setProgress(5);

      const initiateResponse = await axios.post(`${API_BASE_URL}/upload/initiate`, {
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
      });

      const { videoId: newVideoId, uploadUrl } = initiateResponse.data;
      setVideoId(newVideoId);
      console.log(`🆔 Video ID: ${newVideoId}`);

      // Step 2: Upload full video to S3
      setUploadStatus('Uploading video to S3...');
      console.log(`📤 Uploading ${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB video...`);

      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        body: selectedFile,
        headers: {
          'Content-Type': 'video/mp4',
        },
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed with status ${uploadResponse.status}`);
      }

      console.log('✅ Video uploaded to S3');
      setUploading(false);
      setProgress(25);

      // Step 3: Process video (backend downloads, chunks with FFmpeg, uploads chunks)
      setProcessing(true);
      setUploadStatus('Processing video with FFmpeg (chunking)...');
      console.log('✂️  Backend is chunking video with FFmpeg...');

      const processResponse = await axios.post(`${API_BASE_URL}/upload/process`, {
        videoId: newVideoId,
      });

      const { totalChunks } = processResponse.data;
      setChunkCount(totalChunks);
      console.log(`✅ Video chunked into ${totalChunks} valid MP4 segments`);
      setProcessing(false);
      setProgress(50);

      // Step 4: Trigger analysis
      setAnalyzing(true);
      setUploadStatus(`Analyzing ${totalChunks} chunks...`);
      console.log(`🚀 Sending ${totalChunks} chunk URLs to FastAPI...`);

      const analyzeResponse = await axios.post(`${API_BASE_URL}/upload/analyze`, {
        videoId: newVideoId,
      });

      const { analysisResults: results } = analyzeResponse.data;
      setAnalysisResults(results);
      console.log('✅ Analysis completed');
      setProgress(80);

      // Step 5: Set video URL to playback endpoint (returns presigned URL to original video)
      // Backend returns the presigned URL for the original video in S3
      setUploadStatus('Getting playback URL...');
      const playbackResponse = await axios.get(`${API_BASE_URL}/upload/playback/${newVideoId}`);
      const { playbackUrl } = playbackResponse.data;
      
      setVideoUrl(playbackUrl);

      setAnalyzing(false);
      setUploadStatus('Complete! Video ready to play.');
      setProgress(100);
    } catch (err) {
      console.error('Upload error:', err);
      setError(err.response?.data?.message || err.message || 'Upload failed');
      setUploading(false);
      setProcessing(false);
      setAnalyzing(false);
    }
  };

  return (
    <div className="app">
      <div className="header">
        <h1>🎥 Video Upload & Analysis</h1>
        <p>FFmpeg-powered chunking with valid MP4 segments</p>
      </div>

      {/* File Upload Section */}
      <div className="upload-section">
        <div className="file-input-container">
          <label htmlFor="video-input" className="file-label">
            <h3>📁 Select Video File</h3>
            <p>Backend will chunk with FFmpeg at keyframes</p>
          </label>
          <input
            id="video-input"
            type="file"
            accept="video/*"
            onChange={handleFileSelect}
            disabled={uploading || processing || analyzing}
          />
        </div>

        {selectedFile && (
          <div className="selected-file">
            <h4>Selected File:</h4>
            <p><strong>Name:</strong> {selectedFile.name}</p>
            <p><strong>Size:</strong> {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB</p>
            <p><strong>Type:</strong> {selectedFile.type}</p>
            <p><strong>Processing:</strong></p>
            <ul style={{ marginLeft: '20px', marginTop: '5px' }}>
              <li>✅ Upload full video to S3</li>
              <li>✅ Backend chunks with FFmpeg (120s segments)</li>
              <li>✅ Each chunk = valid MP4 with correct metadata</li>
              <li>✅ FastAPI gets all chunk URLs (parallel processing)</li>
            </ul>
          </div>
        )}

        <button
          className="upload-button"
          onClick={handleUpload}
          disabled={!selectedFile || uploading || processing || analyzing}
        >
          {uploading ? 'Uploading...' : processing ? 'Chunking with FFmpeg...' : analyzing ? 'Analyzing...' : 'Upload & Analyze'}
        </button>
      </div>

      {/* Progress Section */}
      {(uploading || processing || analyzing) && (
        <div className="progress-section">
          <div className="progress-bar-container">
            <div className="progress-bar" style={{ width: `${progress}%` }}>
              {progress}%
            </div>
          </div>
          <div className="progress-info">
            <p>{uploadStatus}</p>
          </div>

          {processing && (
            <div className="spinner">
              <div className="spinner-animation"></div>
              <p>✂️  FFmpeg is chunking video into valid MP4 segments...</p>
              <p style={{ color: '#999', fontSize: '0.9rem', marginTop: '10px' }}>
                This ensures each chunk is playable with correct duration
              </p>
            </div>
          )}

          {analyzing && (
            <div className="spinner">
              <div className="spinner-animation"></div>
              <p>🔍 Analyzing {chunkCount} chunks... This may take up to 5 minutes.</p>
              <p style={{ color: '#999', fontSize: '0.9rem', marginTop: '10px' }}>
                FastAPI is processing all chunks in parallel
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
          <p>Video chunked into {chunkCount} valid MP4 segments and analyzed successfully!</p>
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
            <video ref={videoRef} controls>
              <source src={videoUrl} type="video/mp4" />
              Your browser does not support the video tag.
            </video>
          </div>
          <p style={{ textAlign: 'center', marginTop: '10px', color: '#999', fontSize: '0.9rem' }}>
            ✅ Streaming all {chunkCount} chunks server-side (backend does the stitching!)
          </p>
        </div>
      )}
    </div>
  );
}

export default App;
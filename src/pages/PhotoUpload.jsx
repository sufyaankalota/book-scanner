import React, { useState, useRef, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { db } from '../firebase';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';

export default function PhotoUpload() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('t');
  const [photoData, setPhotoData] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [cameraStream, setCameraStream] = useState(null);
  const [useCamera, setUseCamera] = useState(false);
  const videoRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => {
    return () => {
      if (cameraStream) cameraStream.getTracks().forEach((t) => t.stop());
    };
  }, [cameraStream]);

  if (!token) {
    return (
      <div style={styles.container}>
        <h1 style={styles.title}>Invalid Link</h1>
        <p style={styles.text}>This upload link is missing the required token.</p>
      </div>
    );
  }

  if (done) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
          <h1 style={styles.title}>Photo Uploaded!</h1>
          <p style={styles.text}>You can close this page now. The photo has been sent to the scanner station.</p>
        </div>
      </div>
    );
  }

  const startCamera = async () => {
    setUseCamera(true);
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      setCameraStream(stream);
      if (videoRef.current) videoRef.current.srcObject = stream;
    } catch (err) {
      setError('Camera access denied or not available.');
      setUseCamera(false);
    }
  };

  const captureFromCamera = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const MAX = 400;
    const scale = Math.min(MAX / video.videoWidth, MAX / video.videoHeight, 1);
    canvas.width = video.videoWidth * scale;
    canvas.height = video.videoHeight * scale;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    setPhotoData(canvas.toDataURL('image/jpeg', 0.6));
    // Stop camera
    if (cameraStream) {
      cameraStream.getTracks().forEach((t) => t.stop());
      setCameraStream(null);
    }
    setUseCamera(false);
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX = 400;
        const scale = Math.min(MAX / img.width, MAX / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        setPhotoData(canvas.toDataURL('image/jpeg', 0.6));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };

  const handleUpload = async () => {
    if (!photoData || !token) return;
    setUploading(true);
    setError('');
    try {
      await setDoc(doc(db, 'photo-uploads', token), {
        photo: photoData,
        timestamp: serverTimestamp(),
      });
      setDone(true);
    } catch (err) {
      setError('Upload failed. Please try again.');
    }
    setUploading(false);
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>📸 Upload Exception Photo</h1>
        <p style={styles.text}>Take a photo of the item to attach to the exception log.</p>

        {!photoData && !useCamera && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <button onClick={startCamera} style={styles.btn}>
              📷 Open Camera
            </button>
            <button onClick={() => fileRef.current?.click()} style={styles.btnSecondary}>
              📁 Choose from Gallery
            </button>
            <input ref={fileRef} type="file" accept="image/*" capture="environment"
              onChange={handleFile} style={{ display: 'none' }} />
          </div>
        )}

        {useCamera && (
          <div style={{ marginBottom: 16 }}>
            <video ref={(el) => { videoRef.current = el; if (el && cameraStream) el.srcObject = cameraStream; }}
              autoPlay playsInline muted
              style={{ width: '100%', borderRadius: 12, backgroundColor: '#000', marginBottom: 12 }} />
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={captureFromCamera} style={{ ...styles.btn, flex: 1 }}>📸 Capture</button>
              <button onClick={() => { if (cameraStream) cameraStream.getTracks().forEach(t => t.stop()); setCameraStream(null); setUseCamera(false); }}
                style={styles.btnSecondary}>Cancel</button>
            </div>
          </div>
        )}

        {photoData && (
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <img src={photoData} alt="Captured photo"
              style={{ width: '100%', maxWidth: 300, borderRadius: 12, border: '2px solid #22C55E', marginBottom: 12 }} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button onClick={handleUpload} disabled={uploading}
                style={{ ...styles.btn, opacity: uploading ? 0.6 : 1 }}>
                {uploading ? '⏳ Uploading...' : '✅ Send Photo'}
              </button>
              <button onClick={() => setPhotoData(null)} style={styles.btnSecondary}>
                🔄 Retake
              </button>
            </div>
          </div>
        )}

        {error && <p style={{ color: '#EF4444', fontSize: 14, textAlign: 'center', marginTop: 12 }}>{error}</p>}
      </div>
    </div>
  );
}

const styles = {
  container: {
    minHeight: '100vh',
    backgroundColor: '#111',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  card: {
    backgroundColor: '#1a1a1a',
    borderRadius: 16,
    padding: 32,
    width: '100%',
    maxWidth: 400,
    border: '1px solid #333',
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: '#fff',
    margin: '0 0 8px 0',
    textAlign: 'center',
  },
  text: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 1.5,
  },
  btn: {
    padding: '14px 24px',
    borderRadius: 10,
    border: 'none',
    backgroundColor: '#3B82F6',
    color: '#fff',
    fontSize: 16,
    fontWeight: 700,
    cursor: 'pointer',
    textAlign: 'center',
  },
  btnSecondary: {
    padding: '12px 20px',
    borderRadius: 10,
    border: '1px solid #555',
    backgroundColor: '#222',
    color: '#ccc',
    fontSize: 15,
    cursor: 'pointer',
    textAlign: 'center',
  },
};

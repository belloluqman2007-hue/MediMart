import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { Button } from './ui';

/**
 * Camera barcode capture for Android and desktop cameras.
 *
 * The Android WebView exposes `BarcodeDetector` on supported devices; where it is unavailable the
 * camera is still shown, and the clerk keeps using the hardware scanner or keyboard. Only the
 * decoded text leaves this component — no frame is stored, uploaded or logged.
 *
 * The camera is opened only after an explicit tap, and the stream is always stopped when the panel
 * closes or the component unmounts.
 */

type DetectedBarcode = { rawValue: string };
type Detector = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
type DetectorConstructor = new (options?: { formats?: string[] }) => Detector;

function detectorConstructor(): DetectorConstructor | null {
  const candidate = (globalThis as unknown as { BarcodeDetector?: DetectorConstructor })
    .BarcodeDetector;
  return typeof candidate === 'function' ? candidate : null;
}

export function CameraScanner({
  open,
  onClose,
  onDetected,
}: {
  open: boolean;
  onClose: () => void;
  onDetected: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Derived during render: no effect needs to assign it.
  const supported = detectorConstructor() !== null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const Detector = detectorConstructor();

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        if (!Detector) return;
        const detector = new Detector({
          formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'],
        });
        timer = setInterval(() => {
          const video = videoRef.current;
          if (!video || video.readyState < 2) return;
          void detector
            .detect(video)
            .then((codes) => {
              const value = codes[0]?.rawValue?.trim();
              if (value) {
                onDetected(value);
                onClose();
              }
            })
            .catch(() => undefined);
        }, 400);
      } catch {
        if (!cancelled)
          setError(
            'The camera could not be opened. Allow camera access for MediMart in Android settings, or use the scanner field.',
          );
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      for (const track of streamRef.current?.getTracks() ?? []) track.stop();
      streamRef.current = null;
    };
  }, [open, onClose, onDetected]);

  if (!open) return null;
  return (
    <div className="camera-scanner" role="dialog" aria-label="Scan a barcode with the camera">
      <div className="camera-scanner-frame">
        <video ref={videoRef} muted playsInline aria-label="Camera preview" />
        <div className="camera-scanner-reticle" aria-hidden="true" />
      </div>
      <div className="camera-scanner-footer">
        <p className="small">
          {supported
            ? 'Point the camera at the barcode. Nothing is saved or uploaded.'
            : 'This device cannot decode barcodes from the camera. Type the code or use a scanner.'}
        </p>
        {error && <p className="field-error small">{error}</p>}
        <Button type="button" variant="secondary" onClick={onClose}>
          <X size={15} /> Close camera
        </Button>
      </div>
    </div>
  );
}

export function CameraScanButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="secondary" onClick={onClick}>
      <Camera size={15} /> Camera
    </Button>
  );
}

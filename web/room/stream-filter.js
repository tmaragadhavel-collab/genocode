// Processes a screen-share video track through a canvas, painting over the
// coaching overlay region before the frames reach LiveKit.  The candidate
// sees coaching on their screen; the interviewer receives a clean stream.

export function createStreamFilter({ sourceTrack, getOverlayRect, surface }) {
  const video = document.createElement('video');
  video.srcObject = new MediaStream([sourceTrack]);
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let running = true;

  function mapRect(rect) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !rect) return null;
    const pad = 8;

    if (surface === 'browser') {
      const sx = vw / window.innerWidth;
      const sy = vh / window.innerHeight;
      return { x: rect.left * sx - pad, y: rect.top * sy - pad, w: rect.width * sx + pad * 2, h: rect.height * sy + pad * 2 };
    }
    const chromeTop = window.outerHeight - window.innerHeight;
    const chromeLeft = Math.round((window.outerWidth - window.innerWidth) / 2);
    if (surface === 'window') {
      const sx = vw / window.outerWidth;
      const sy = vh / window.outerHeight;
      return { x: (chromeLeft + rect.left) * sx - pad, y: (chromeTop + rect.top) * sy - pad, w: rect.width * sx + pad * 2, h: rect.height * sy + pad * 2 };
    }
    // monitor or unknown — map to full screen
    const sx = vw / screen.width;
    const sy = vh / screen.height;
    return {
      x: (window.screenX + chromeLeft + rect.left) * sx - pad,
      y: (window.screenY + chromeTop + rect.top) * sy - pad,
      w: rect.width * sx + pad * 2,
      h: rect.height * sy + pad * 2,
    };
  }

  function draw() {
    if (!running) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw && vh) {
      if (canvas.width !== vw) canvas.width = vw;
      if (canvas.height !== vh) canvas.height = vh;
      ctx.drawImage(video, 0, 0);
      const rect = getOverlayRect();
      const m = mapRect(rect);
      if (m && m.w > 0 && m.h > 0) {
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#111318';
        ctx.fillStyle = bg;
        ctx.fillRect(m.x, m.y, m.w, m.h);
      }
    }
    requestAnimationFrame(draw);
  }

  const ready = video.play().then(() => { draw(); });
  const outputTrack = canvas.captureStream(30).getVideoTracks()[0];

  sourceTrack.addEventListener('ended', () => {
    running = false;
    outputTrack.stop();
  });

  return {
    ready,
    track: outputTrack,
    stop() {
      running = false;
      video.pause();
      video.srcObject = null;
      sourceTrack.stop();
      outputTrack.stop();
    },
  };
}

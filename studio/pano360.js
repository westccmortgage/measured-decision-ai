/* Measured Decision · 360 evidence viewer.

   A dependency-free equirectangular viewer. It renders a full-screen quad and
   resolves the view direction per pixel, so no sphere mesh or external 3D
   library is required. Photos, equirectangular MP4 exports, and non-spatial
   media all open through the same entry point, which keeps "open the evidence"
   a single action everywhere in the Studio.

   window.MDAIPano360.open({ src, mediaType, title, subtitle, spatial, trim, actions,
                            markers, evidenceId, canReviewMarkers,
                            onMarkerReview, onMarkerPlace, onMarkerRequest })
*/
(() => {
  const VERTEX_SHADER = `
    attribute vec2 position;
    varying vec2 vScreen;
    void main() {
      vScreen = position;
      gl_Position = vec4(position, 0.0, 1.0);
    }`;

  const FRAGMENT_SHADER = `
    precision highp float;
    varying vec2 vScreen;
    uniform sampler2D source;
    uniform float yaw;
    uniform float pitch;
    uniform float tanHalfFov;
    uniform float aspect;
    const float PI = 3.14159265359;
    void main() {
      vec3 ray = normalize(vec3(vScreen.x * tanHalfFov * aspect, vScreen.y * tanHalfFov, -1.0));
      float cp = cos(pitch);
      float sp = sin(pitch);
      vec3 tilted = vec3(ray.x, ray.y * cp - ray.z * sp, ray.y * sp + ray.z * cp);
      float cy = cos(yaw);
      float sy = sin(yaw);
      vec3 dir = vec3(tilted.x * cy + tilted.z * sy, tilted.y, -tilted.x * sy + tilted.z * cy);
      float u = atan(dir.x, -dir.z) / (2.0 * PI) + 0.5;
      float v = acos(clamp(dir.y, -1.0, 1.0)) / PI;
      gl_FragColor = texture2D(source, vec2(u, v));
    }`;

  const STYLE = `
    .pano-overlay{position:fixed;inset:0;z-index:120;display:flex;flex-direction:column;background:#04090f}
    .pano-overlay[hidden]{display:none}
    .pano-bar{display:flex;align-items:center;gap:12px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:linear-gradient(180deg,rgba(4,9,15,.94),rgba(4,9,15,0));position:absolute;inset:0 0 auto;z-index:2}
    .pano-bar .pano-titles{min-width:0;flex:1}
    .pano-bar strong{display:block;font-size:15px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pano-bar small{display:block;margin-top:2px;color:#8fa2b5;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pano-icon{flex:0 0 auto;min-width:44px;min-height:44px;padding:0 12px;border:1px solid #2b425c;border-radius:10px;background:rgba(10,20,33,.72);color:#edf4f7;font:inherit;font-size:13px;cursor:pointer}
    .pano-icon:hover{border-color:#52d2df}
    .pano-icon[aria-pressed="true"]{border-color:#52d2df;background:rgba(82,210,223,.16);color:#52d2df}
    .pano-stage{position:relative;flex:1;min-height:0;display:grid;place-items:center;overflow:hidden;touch-action:none}
    .pano-stage canvas{width:100%;height:100%;display:block;cursor:grab}
    .pano-stage canvas.dragging{cursor:grabbing}
    .pano-stage>img,.pano-stage>video.pano-flat{max-width:100%;max-height:100%;object-fit:contain}
    .pano-stage>.pano-doc{padding:32px;text-align:center;color:#a5b8c8}
    .pano-stage>.pano-doc a{display:inline-block;margin-top:16px;padding:14px 22px;border-radius:10px;background:#52d2df;color:#06111d;font-weight:600;text-decoration:none}
    .pano-hint{position:absolute;left:50%;top:calc(74px + env(safe-area-inset-top));transform:translateX(-50%);max-width:calc(100% - 32px);text-align:center;padding:8px 14px;border-radius:999px;background:rgba(4,9,15,.72);color:#a5b8c8;font-size:12px;pointer-events:none;transition:opacity 400ms ease}
    .pano-foot{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(0deg,rgba(4,9,15,.94),rgba(4,9,15,0));position:absolute;inset:auto 0 0;z-index:2}
    .pano-foot button{flex:1 1 auto;min-height:46px;padding:0 16px;border:1px solid #35506a;border-radius:10px;background:rgba(10,20,33,.82);color:#edf4f7;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
    .pano-foot button.primary{border-color:#52d2df;background:#52d2df;color:#06111d}
    .pano-playback{position:absolute;left:50%;bottom:calc(74px + env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:999px;background:rgba(4,9,15,.78);z-index:2}
    .pano-playback button{min-width:44px;min-height:36px;border:0;border-radius:8px;background:rgba(255,255,255,.08);color:#edf4f7;font:inherit;cursor:pointer}
    .pano-playback input{width:min(46vw,260px)}
    .pano-playback .pano-window{min-width:auto;padding:0 12px;font-size:12px;white-space:nowrap}
    .pano-playback .pano-window[aria-pressed="true"]{background:rgba(82,210,223,.18);color:#52d2df}
    .pano-trim-note{position:absolute;left:50%;bottom:calc(122px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100% - 32px);text-align:center;padding:6px 12px;border-radius:999px;background:rgba(4,9,15,.72);color:#a5b8c8;font-size:12px;z-index:2;pointer-events:none}

    /* Markers sit above the sphere and are positioned every frame from the same
       view the shader draws, so a pin never drifts off the thing it points at. */
    .pano-markers{position:absolute;inset:0;pointer-events:none;z-index:1}
    /* The pin itself has no size: the dot is centred on the anchor and the label
       hangs off it, so the ring sits on the thing and not next to it. */
    .pano-pin{position:absolute;left:0;top:0;width:0;height:0;padding:0;border:0;background:none;color:#edf4f7;font:inherit;cursor:pointer;pointer-events:none;white-space:nowrap}
    .pano-pin i{position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;border:2px solid #52d2df;background:rgba(4,9,15,.55);box-shadow:0 0 0 4px rgba(82,210,223,.16);transition:transform 120ms ease}
    .pano-pin b{position:absolute;left:18px;top:-11px;display:block;font:600 12px/1 inherit;padding:6px 10px;border-radius:999px;background:rgba(4,9,15,.82);border:1px solid rgba(255,255,255,.12);max-width:44vw;overflow:hidden;text-overflow:ellipsis}
    .pano-pin.state-ok i{border-color:#6fd8a8;box-shadow:0 0 0 4px rgba(111,216,168,.16)}
    .pano-pin.state-wait i{border-color:#e8b070;box-shadow:0 0 0 4px rgba(232,176,112,.16)}
    .pano-pin.state-off i{border-color:#7f8fa0;box-shadow:none;opacity:.6}
    .pano-pin.far b{display:none}
    .pano-pin.far i{left:-7px;top:-7px;width:14px;height:14px}
    .pano-pin[aria-expanded="true"] i{transform:scale(1.25)}
    .pano-pin:focus-visible{outline:2px solid #52d2df;outline-offset:6px;border-radius:999px}
    .pano-reticle{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border:1px solid rgba(82,210,223,.7);border-radius:50%;pointer-events:none;z-index:1}
    .pano-reticle::after{content:"";position:absolute;inset:20px;border-radius:50%;background:#52d2df}
    .pano-card{position:absolute;inset:auto 0 0;z-index:4;max-height:72%;overflow:auto;padding:18px 18px calc(18px + env(safe-area-inset-bottom));background:#0b1622;border-top:1px solid #24384c;border-radius:16px 16px 0 0;box-shadow:0 -18px 44px rgba(0,0,0,.45)}
    .pano-card h3{margin:8px 0 4px;font-size:17px;line-height:1.25}
    .pano-card p{margin:0 0 10px;color:#a5b8c8;font-size:13px;line-height:1.5}
    .pano-card dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0 0 14px;font-size:13px}
    .pano-card dt{color:#7f96aa}
    .pano-card dd{margin:0;color:#dce7ef}
    .pano-card dd.missing{color:#e8b070}
    .pano-chip{display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid;font-size:11px;font-style:normal;font-weight:600}
    .pano-chip.review{color:#e8b070;border-color:rgba(232,176,112,.5);background:rgba(232,176,112,.1)}
    .pano-chip.ok{color:#6fd8a8;border-color:rgba(111,216,168,.5);background:rgba(111,216,168,.1)}
    .pano-chip.wait{color:#9db4ff;border-color:rgba(157,180,255,.5);background:rgba(157,180,255,.1)}
    .pano-chip.off{color:#93a5b6;border-color:rgba(147,165,182,.45);background:rgba(147,165,182,.1)}
    .pano-card-actions{display:flex;flex-wrap:wrap;gap:8px}
    .pano-card-actions button{flex:1 1 auto;min-height:44px;padding:0 14px;border:1px solid #35506a;border-radius:10px;background:rgba(10,20,33,.9);color:#edf4f7;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
    .pano-card-actions button.primary{border-color:#52d2df;background:#52d2df;color:#06111d}
    .pano-card-actions button.quiet{border-color:#2b3f55;color:#a5b8c8;font-weight:500}
    .pano-card-close{position:absolute;right:12px;top:12px;min-width:40px;min-height:40px;border:0;border-radius:10px;background:rgba(255,255,255,.06);color:#a5b8c8;font:inherit;cursor:pointer}
    .pano-list{position:absolute;inset:auto 0 0;z-index:4;max-height:72%;overflow:auto;padding:14px 14px calc(14px + env(safe-area-inset-bottom));background:#0b1622;border-top:1px solid #24384c;border-radius:16px 16px 0 0}
    .pano-list h3{margin:0 0 10px;font-size:14px;color:#a5b8c8;font-weight:600}
    .pano-list button.row{display:flex;width:100%;align-items:center;gap:10px;min-height:48px;margin-bottom:6px;padding:8px 12px;border:1px solid #22364a;border-radius:10px;background:rgba(10,20,33,.7);color:#edf4f7;font:inherit;font-size:13px;text-align:left;cursor:pointer}
    .pano-list button.row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    @media(max-width:640px){.pano-bar small{display:none}}
  `;

  let root = null;
  let stage = null;
  let footer = null;
  let titleNode = null;
  let subtitleNode = null;
  let hintNode = null;
  let gyroButton = null;
  let markerButton = null;
  let playback = null;
  let trimNote = null;
  let session = null;
  let restoreOverflow = "";

  function injectStyle() {
    if (document.getElementById("pano360-style")) return;
    const style = document.createElement("style");
    style.id = "pano360-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function escapeText(value) {
    const span = document.createElement("span");
    span.textContent = value == null ? "" : value;
    return span.innerHTML;
  }

  function build() {
    injectStyle();
    root = document.createElement("div");
    root.className = "pano-overlay";
    root.hidden = true;
    root.innerHTML = `
      <div class="pano-bar">
        <button class="pano-icon" type="button" data-pano-close aria-label="Close viewer">← Back</button>
        <div class="pano-titles"><strong data-pano-title>Evidence</strong><small data-pano-subtitle></small></div>
        <button class="pano-icon" type="button" data-pano-markers hidden>◎ Mark</button>
        <button class="pano-icon" type="button" data-pano-gyro aria-pressed="false" hidden>Look around</button>
      </div>
      <div class="pano-stage" data-pano-stage></div>
      <div class="pano-foot" data-pano-foot></div>`;
    document.body.appendChild(root);
    stage = root.querySelector("[data-pano-stage]");
    footer = root.querySelector("[data-pano-foot]");
    titleNode = root.querySelector("[data-pano-title]");
    subtitleNode = root.querySelector("[data-pano-subtitle]");
    gyroButton = root.querySelector("[data-pano-gyro]");
    markerButton = root.querySelector("[data-pano-markers]");
    markerButton.addEventListener("click", openMarkerList);
    root.querySelector("[data-pano-close]").addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !root.hidden) close();
    });
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed");
    }
    return shader;
  }

  function startSphere(media, isVideo, onFrame) {
    const canvas = document.createElement("canvas");
    stage.appendChild(canvas);
    const gl =
      canvas.getContext("webgl", { antialias: false, alpha: false }) ||
      canvas.getContext("experimental-webgl", { antialias: false, alpha: false });
    if (!gl) throw new Error("WebGL unavailable");

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    /* An equirectangular frame stores the zenith in its first row, and the
       shader samples it that way: v = 0 is straight up. Flipping the upload
       turned the sphere over — looking up showed the floor. */
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const uniforms = {
      yaw: gl.getUniformLocation(program, "yaw"),
      pitch: gl.getUniformLocation(program, "pitch"),
      tanHalfFov: gl.getUniformLocation(program, "tanHalfFov"),
      aspect: gl.getUniformLocation(program, "aspect"),
    };

    const view = { yaw: 0, pitch: 0, fov: 1.4 };
    const state = { alive: true, dragging: false, gyro: false, frame: 0, textureReady: false };

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(stage.clientWidth * ratio));
      const height = Math.max(1, Math.round(stage.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    }

    function uploadTexture() {
      const ready = isVideo ? media.readyState >= 2 : media.complete && media.naturalWidth > 0;
      if (!ready) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, media);
      state.textureReady = true;
    }

    function draw() {
      if (!state.alive) return;
      state.frame = window.requestAnimationFrame(draw);
      resize();
      if (isVideo || !state.textureReady) uploadTexture();
      if (!state.textureReady) return;
      gl.uniform1f(uniforms.yaw, view.yaw);
      gl.uniform1f(uniforms.pitch, view.pitch);
      gl.uniform1f(uniforms.tanHalfFov, Math.tan(view.fov / 2));
      const aspect = canvas.width / Math.max(1, canvas.height);
      gl.uniform1f(uniforms.aspect, aspect);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // The marker layer is positioned from the very same view the shader just
      // drew, in the same frame, so a pin can never lag the sphere by a frame.
      onFrame?.({ yaw: view.yaw, pitch: view.pitch, fov: view.fov, aspect });
    }

    const pointers = new Map();
    let pinchDistance = 0;
    let last = null;

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      last = { x: event.clientX, y: event.clientY };
      state.dragging = true;
      canvas.classList.add("dragging");
      hide(hintNode);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance) {
          view.fov = Math.min(2.2, Math.max(0.35, view.fov * (pinchDistance / Math.max(1, distance))));
        }
        pinchDistance = distance;
        return;
      }
      if (!state.dragging || !last) return;
      const scale = view.fov / Math.max(240, stage.clientHeight);
      view.yaw -= (event.clientX - last.x) * scale;
      view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch - (event.clientY - last.y) * scale));
      last = { x: event.clientX, y: event.clientY };
      state.gyro = false;
      if (gyroButton) gyroButton.setAttribute("aria-pressed", "false");
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((name) =>
      canvas.addEventListener(name, (event) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinchDistance = 0;
        if (!pointers.size) {
          state.dragging = false;
          last = null;
          canvas.classList.remove("dragging");
        }
      }),
    );
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      view.fov = Math.min(2.2, Math.max(0.35, view.fov + event.deltaY * 0.0016));
    }, { passive: false });

    function onOrientation(event) {
      if (!state.gyro || event.alpha == null) return;
      const rad = Math.PI / 180;
      view.yaw = -event.alpha * rad;
      view.pitch = Math.max(-1.5, Math.min(1.5, (event.beta - 90) * rad));
    }

    if (gyroButton && window.DeviceOrientationEvent) {
      gyroButton.hidden = false;
      gyroButton.onclick = async () => {
        if (state.gyro) {
          state.gyro = false;
          gyroButton.setAttribute("aria-pressed", "false");
          return;
        }
        try {
          const request = window.DeviceOrientationEvent.requestPermission;
          if (typeof request === "function" && (await request()) !== "granted") return;
        } catch {
          return;
        }
        state.gyro = true;
        gyroButton.setAttribute("aria-pressed", "true");
      };
      window.addEventListener("deviceorientation", onOrientation);
    }

    draw();

    const dispose = () => {
      state.alive = false;
      window.cancelAnimationFrame(state.frame);
      window.removeEventListener("deviceorientation", onOrientation);
      if (gyroButton) {
        gyroButton.hidden = true;
        gyroButton.onclick = null;
        gyroButton.setAttribute("aria-pressed", "false");
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };

    /* Looking at a marker is one press, not a hunt: the view turns to it along
       the shortest way round, because a reviewer in a headset should never have
       to spin twice to reach a point that was one step to the left. */
    function lookAt(target, instant) {
      const from = { yaw: view.yaw, pitch: view.pitch };
      let delta = target.yaw - from.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      const to = { yaw: from.yaw + delta, pitch: Math.max(-1.5, Math.min(1.5, target.pitch)) };
      state.gyro = false;
      if (gyroButton) gyroButton.setAttribute("aria-pressed", "false");
      if (instant) {
        view.yaw = to.yaw;
        view.pitch = to.pitch;
        return;
      }
      const started = performance.now();
      const step = (now) => {
        if (!state.alive) return;
        const progress = Math.min(1, (now - started) / 420);
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
        view.yaw = from.yaw + (to.yaw - from.yaw) * eased;
        view.pitch = from.pitch + (to.pitch - from.pitch) * eased;
        if (progress < 1) window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    }

    return { dispose, lookAt, view, canvas };
  }

  function hide(node) {
    if (!node) return;
    node.style.opacity = "0";
    window.setTimeout(() => node.remove(), 400);
  }

  /* The window is a window, not a cut: playback, the scrubber and the loop all
     stay inside it, and one button plays the untouched original when a reviewer
     needs to see everything that was filmed. */
  function trimBounds(video, trim, active) {
    const duration = Number(video.duration) || 0;
    if (!active || !trim || !trim.applied) return { start: 0, end: duration };
    const start = Math.max(0, Math.min(Number(trim.start_seconds) || 0, Math.max(0, duration - 1)));
    const end = duration ? Math.min(Number(trim.end_seconds) || duration, duration) : Number(trim.end_seconds) || 0;
    return end > start + 0.5 ? { start, end } : { start: 0, end: duration };
  }

  function buildPlayback(video, trim) {
    const trimmable = Boolean(trim && trim.applied);
    let windowed = trimmable;
    playback = document.createElement("div");
    playback.className = "pano-playback";
    playback.innerHTML = `<button type="button" data-pano-play aria-label="Play or pause">▶</button><input type="range" min="0" max="1000" value="0" step="1" aria-label="Playback position">` +
      (trimmable ? `<button type="button" class="pano-window" data-pano-window aria-pressed="true">Full clip</button>` : "");
    stage.appendChild(playback);
    const button = playback.querySelector("[data-pano-play]");
    const range = playback.querySelector("input");
    const windowButton = playback.querySelector("[data-pano-window]");
    const bounds = () => trimBounds(video, trim, windowed);

    button.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    video.addEventListener("play", () => { button.textContent = "❚❚"; });
    video.addEventListener("pause", () => { button.textContent = "▶"; });
    video.addEventListener("timeupdate", () => {
      const { start, end } = bounds();
      if (windowed && end > start && (video.currentTime >= end - 0.05 || video.currentTime < start - 0.5)) {
        video.currentTime = start;
        return;
      }
      if (range.dataset.seeking === "1" || end <= start) return;
      range.value = String(Math.round(((video.currentTime - start) / (end - start)) * 1000));
    });
    range.addEventListener("pointerdown", () => { range.dataset.seeking = "1"; });
    range.addEventListener("change", () => {
      range.dataset.seeking = "0";
      const { start, end } = bounds();
      if (end > start) video.currentTime = start + (Number(range.value) / 1000) * (end - start);
    });

    if (windowButton) {
      windowButton.addEventListener("click", () => {
        windowed = !windowed;
        windowButton.setAttribute("aria-pressed", windowed ? "true" : "false");
        windowButton.textContent = windowed ? "Full clip" : "Trimmed";
        if (trimNote) trimNote.hidden = !windowed;
        const { start, end } = bounds();
        if (video.currentTime < start || video.currentTime > end) video.currentTime = start;
      });
    }
  }

  function trimText(trim) {
    if (!trim || !trim.applied) return "";
    const head = Number(trim.head_seconds) || 0;
    const tail = Number(trim.tail_seconds) || 0;
    return head === tail
      ? `First and last ${head}s hidden — camera handling`
      : `First ${head}s and last ${tail}s hidden — camera handling`;
  }

  function showTrimNote(trim) {
    const text = trimText(trim);
    if (!text) return;
    trimNote = document.createElement("p");
    trimNote.className = "pano-trim-note";
    trimNote.textContent = text;
    stage.appendChild(trimNote);
  }

  /* A capture uploaded before the policy existed carries no window, so the
     policy is applied to the stream that is playing. Non-spatial evidence is
     never passed a window at all and is therefore never trimmed. */
  function resolveTrim(trim, video) {
    if (!trim) return null;
    if (!window.MDAITrim360) return trim.applied ? trim : null;
    const resolved = window.MDAITrim360.resolve({ trim }, Number(video && video.duration) || 0);
    return resolved.applied ? resolved : null;
  }

  function seekToWindowStart(video, trim) {
    if (!trim) return;
    const seek = () => {
      const resolved = resolveTrim(trim, video);
      if (!resolved) return;
      const { start } = trimBounds(video, resolved, true);
      if (start > 0 && Math.abs(video.currentTime - start) > 0.2) video.currentTime = start;
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
  }

  /* ------------------------------------------------------------- Markers */

  /* A marker answers, in place, the questions a paragraph cannot: what is this,
     who says so, which file and second shows it, what has it cost, and which
     document covers it. Where the record has no answer the card says so and
     offers the only useful next move — asking for the missing document. */

  const markerState = {
    list: [],
    sphere: null,
    media: null,
    canReview: false,
    canPlace: false,
    onReview: null,
    onPlace: null,
    onRequest: null,
    layer: null,
    pins: new Map(),
    openId: null,
    aiming: false,
  };

  function markerTone(marker) {
    return window.MDAIMarkers360?.stateTone(marker.state) || "review";
  }

  function markerStateLabel(marker) {
    return window.MDAIMarkers360?.stateLabel(marker.state) || "Seen by AI · not verified";
  }

  function clearMarkerPanels() {
    stage.querySelectorAll(".pano-card, .pano-list").forEach((node) => node.remove());
    markerState.openId = null;
    markerState.pins.forEach((pin) => pin.setAttribute("aria-expanded", "false"));
  }

  function markerMoment(marker) {
    const media = markerState.media;
    if (!media || typeof media.currentTime !== "number") return false;
    const at = Number(marker.timestamp_seconds);
    if (!Number.isFinite(at) || at < 0) return false;
    media.currentTime = at;
    if (media.paused) media.play().catch(() => {});
    return true;
  }

  /* Turning to a marker aims slightly above it: the card that is about to open
     covers the lower part of the screen, and a card that hides the very thing
     it describes is worse than no card. */
  const CARD_CLEARANCE = 0.24;

  function lookAtMarker(marker, instant) {
    if (!markerState.sphere?.lookAt || !window.MDAIMarkers360) return;
    const target = window.MDAIMarkers360.view(marker);
    markerState.sphere.lookAt({ yaw: target.yaw, pitch: target.pitch - CARD_CLEARANCE }, instant);
  }

  function markerRow(term, value, missing) {
    return `<dt>${escapeText(term)}</dt><dd class="${missing ? "missing" : ""}">${escapeText(value)}</dd>`;
  }

  function openMarkerCard(marker) {
    clearMarkerPanels();
    markerState.openId = marker.id;
    markerState.pins.get(marker.id)?.setAttribute("aria-expanded", "true");
    const hasMoment = marker.timestamp_seconds != null && Number.isFinite(Number(marker.timestamp_seconds));
    const timecode = hasMoment ? window.MDAIMarkers360?.timecode(marker.timestamp_seconds) || "" : "";
    const seenIn = [marker.source_name || "this capture", timecode ? `at ${timecode}` : ""]
      .filter(Boolean)
      .join(" ");
    const card = document.createElement("div");
    card.className = "pano-card";
    card.innerHTML = `
      <button class="pano-card-close" type="button" data-marker-close aria-label="Close">✕</button>
      <span class="pano-chip ${markerTone(marker)}">${escapeText(markerStateLabel(marker))}</span>
      <h3>${escapeText(marker.label || "Marked point")}</h3>
      ${marker.detail && marker.detail !== marker.label ? `<p>${escapeText(marker.detail)}</p>` : ""}
      <dl>
        ${markerRow("Seen in", seenIn)}
        ${markerRow(
          "Since the previous capture",
          marker.change || "Not established — no earlier capture of this space is on record",
          !marker.change,
        )}
        ${markerRow("Cost", marker.cost || "Not linked to a cost", !marker.cost)}
        ${markerRow(
          "Document",
          marker.document || (marker.requested ? "Requested — waiting for the contractor" : "No document covers this installation"),
          !marker.document,
        )}
      </dl>
      <div class="pano-card-actions">
        ${hasMoment ? `<button type="button" class="primary" data-marker-moment>Show this moment</button>` : ""}
        ${markerState.canReview && marker.state !== "confirmed" ? `<button type="button" data-marker-review="confirmed">Confirm</button>` : ""}
        ${markerState.canReview && marker.state !== "rejected" ? `<button type="button" data-marker-review="rejected">Incorrect</button>` : ""}
        ${markerState.canReview && marker.state !== "needs_more" ? `<button type="button" data-marker-review="needs_more">Needs more evidence</button>` : ""}
        ${!marker.document && !marker.requested && markerState.onRequest ? `<button type="button" class="quiet" data-marker-request>Ask for the document</button>` : ""}
      </div>`;
    stage.appendChild(card);
    card.querySelector("[data-marker-close]").addEventListener("click", clearMarkerPanels);
    card.querySelector("[data-marker-moment]")?.addEventListener("click", () => {
      if (!markerMoment(marker)) return;
      lookAtMarker(marker);
    });
    card.querySelectorAll("[data-marker-review]").forEach((button) => {
      button.addEventListener("click", () => {
        marker.state = button.dataset.markerReview;
        markerState.onReview?.(marker, marker.state);
        renderMarkerPins();
        openMarkerCard(marker);
      });
    });
    card.querySelector("[data-marker-request]")?.addEventListener("click", () => {
      marker.requested = true;
      markerState.onRequest?.(marker);
      openMarkerCard(marker);
    });
  }

  function openMarkerList() {
    clearMarkerPanels();
    const panel = document.createElement("div");
    panel.className = "pano-list";
    const rows = markerState.list
      .map(
        (marker, index) =>
          `<button class="row" type="button" data-marker-jump="${escapeText(marker.id)}">
             <span>${index + 1}. ${escapeText(marker.label || "Marked point")}</span>
             <em class="pano-chip ${markerTone(marker)}">${escapeText(markerStateLabel(marker))}</em>
           </button>`,
      )
      .join("");
    panel.innerHTML = `
      <button class="pano-card-close" type="button" data-marker-close aria-label="Close">✕</button>
      <h3>${markerState.list.length} point${markerState.list.length === 1 ? "" : "s"} marked in this space</h3>
      ${rows || `<p style="color:#8fa2b5;font-size:13px">Nothing is marked yet. Aim at a point and place the first marker.</p>`}
      ${markerState.canPlace ? `<button class="row" type="button" data-marker-add><span>＋ Place a marker where I am looking</span></button>` : ""}`;
    stage.appendChild(panel);
    panel.querySelector("[data-marker-close]").addEventListener("click", clearMarkerPanels);
    panel.querySelectorAll("[data-marker-jump]").forEach((button) => {
      button.addEventListener("click", () => {
        const marker = markerState.list.find((item) => item.id === button.dataset.markerJump);
        if (!marker) return;
        lookAtMarker(marker);
        openMarkerCard(marker);
      });
    });
    panel.querySelector("[data-marker-add]")?.addEventListener("click", startMarkerPlacement);
  }

  /* Placing by aim rather than by tap: a tap on the sphere is already a drag,
     and in a headset there is no tap at all. Look at the thing, then press. */
  function startMarkerPlacement() {
    clearMarkerPanels();
    markerState.aiming = true;
    const reticle = document.createElement("div");
    reticle.className = "pano-reticle";
    stage.appendChild(reticle);
    const card = document.createElement("div");
    card.className = "pano-card";
    card.innerHTML = `
      <h3>Place a marker</h3>
      <p>Turn the view until the ring sits on the thing you want to mark, then name it.</p>
      <input type="text" data-marker-name placeholder="What is at this point?"
        style="width:100%;min-height:46px;margin-bottom:12px;padding:0 12px;border:1px solid #35506a;border-radius:10px;background:rgba(4,9,15,.6);color:#edf4f7;font:inherit;font-size:14px">
      <div class="pano-card-actions">
        <button type="button" class="primary" data-marker-save>Place it here</button>
        <button type="button" class="quiet" data-marker-cancel>Cancel</button>
      </div>`;
    stage.appendChild(card);
    const input = card.querySelector("[data-marker-name]");
    input.focus();
    const stop = () => {
      markerState.aiming = false;
      reticle.remove();
      card.remove();
    };
    card.querySelector("[data-marker-cancel]").addEventListener("click", stop);
    card.querySelector("[data-marker-save]").addEventListener("click", () => {
      const label = input.value.trim();
      if (!label) {
        input.focus();
        return;
      }
      const anchor = window.MDAIMarkers360.anchorFromView(markerState.sphere.view);
      const marker = window.MDAIMarkers360.place(anchor, {
        label,
        evidence_id: markerState.evidenceId || null,
        timestamp_seconds: markerState.media && typeof markerState.media.currentTime === "number"
          ? Number(markerState.media.currentTime.toFixed(2))
          : null,
      });
      markerState.list.push(marker);
      markerState.onPlace?.(marker);
      stop();
      renderMarkerPins();
      updateMarkerButton();
      openMarkerCard(marker);
    });
  }

  function renderMarkerPins() {
    if (!markerState.layer) return;
    markerState.layer.innerHTML = "";
    markerState.pins.clear();
    markerState.list.forEach((marker, index) => {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = `pano-pin state-${markerTone(marker)}`;
      pin.setAttribute("aria-expanded", markerState.openId === marker.id ? "true" : "false");
      pin.innerHTML = `<i></i><b>${index + 1}. ${escapeText(marker.label || "Marked point")}</b>`;
      // Keyboard reaches the pin directly; a finger reaches it through the
      // canvas, so that dragging the sphere always wins over hitting a dot.
      pin.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        lookAtMarker(marker);
        openMarkerCard(marker);
      });
      markerState.layer.appendChild(pin);
      markerState.pins.set(marker.id, pin);
    });
  }

  function layoutMarkerPins(viewState) {
    if (!markerState.layer || !window.MDAIMarkers360) return;
    const width = markerState.layer.clientWidth;
    const height = markerState.layer.clientHeight;
    markerState.list.forEach((marker) => {
      const pin = markerState.pins.get(marker.id);
      if (!pin) return;
      const point = window.MDAIMarkers360.project(marker, viewState);
      if (!point.visible) {
        pin.style.display = "none";
        return;
      }
      pin.style.display = "";
      // A pin far from where the reviewer is looking keeps its dot and drops
      // its label, so twenty markers never turn the sphere into a wall of text.
      pin.classList.toggle("far", Math.hypot(point.x, point.y) > 0.45);
      const left = ((point.x + 1) / 2) * width;
      const top = ((1 - point.y) / 2) * height;
      pin.style.transform = `translate(${left}px, ${top}px)`;
      pin.dataset.screenX = String(left);
      pin.dataset.screenY = String(top);
    });
  }

  function updateMarkerButton() {
    if (!markerButton) return;
    const count = markerState.list.length;
    const usable = Boolean(markerState.sphere) && (count > 0 || markerState.canPlace);
    markerButton.hidden = !usable;
    markerButton.textContent = count ? `◎ ${count}` : "◎ Mark";
    markerButton.setAttribute(
      "aria-label",
      count ? `${count} marked points in this space` : "Place a marker",
    );
  }

  /* A tap is a press that did not turn the view. Only then is the nearest pin
     within thumb reach opened — so a marker never blocks looking around. */
  function bindMarkerTaps(canvas) {
    let press = null;
    canvas.addEventListener("pointerdown", (event) => {
      press = { x: event.clientX, y: event.clientY, at: performance.now() };
    });
    canvas.addEventListener("pointerup", (event) => {
      const start = press;
      press = null;
      if (!start || markerState.aiming) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
      if (performance.now() - start.at > 700) return;
      const box = canvas.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      let closest = null;
      let distance = 34;
      markerState.list.forEach((marker) => {
        const pin = markerState.pins.get(marker.id);
        if (!pin || pin.style.display === "none") return;
        // The label is as much a target as the dot: a person aims at the words.
        const label = pin.querySelector("b").getBoundingClientRect();
        const onLabel =
          label.width > 0 &&
          event.clientX >= label.left && event.clientX <= label.right &&
          event.clientY >= label.top && event.clientY <= label.bottom;
        const gap = onLabel
          ? 0
          : Math.hypot(Number(pin.dataset.screenX) - x, Number(pin.dataset.screenY) - y);
        if (gap < distance) {
          distance = gap;
          closest = marker;
        }
      });
      if (closest) openMarkerCard(closest);
    });
  }

  function mountMarkers(sphere, media, options) {
    markerState.sphere = sphere;
    markerState.media = media;
    markerState.list = Array.isArray(options.markers) ? options.markers.slice() : [];
    markerState.canReview = Boolean(options.canReviewMarkers);
    markerState.canPlace = Boolean(options.onMarkerPlace);
    markerState.onReview = options.onMarkerReview || null;
    markerState.onPlace = options.onMarkerPlace || null;
    markerState.onRequest = options.onMarkerRequest || null;
    markerState.evidenceId = options.evidenceId || null;
    markerState.layer = document.createElement("div");
    markerState.layer.className = "pano-markers";
    stage.appendChild(markerState.layer);
    renderMarkerPins();
    updateMarkerButton();
    if (sphere?.canvas) bindMarkerTaps(sphere.canvas);
  }

  function resetMarkers() {
    markerState.list = [];
    markerState.sphere = null;
    markerState.media = null;
    markerState.layer = null;
    markerState.pins.clear();
    markerState.openId = null;
    markerState.aiming = false;
    if (markerButton) markerButton.hidden = true;
  }

  function renderFooter(actions = []) {
    footer.innerHTML = "";
    actions
      .filter((action) => action && action.label)
      .forEach((action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        if (action.primary) button.className = "primary";
        button.addEventListener("click", () => action.onSelect?.());
        footer.appendChild(button);
      });
    footer.hidden = !footer.children.length;
  }

  function teardown() {
    resetMarkers();
    if (!session) return;
    session.dispose?.();
    session = null;
    stage.innerHTML = "";
    playback = null;
    trimNote = null;
  }

  function close() {
    teardown();
    root.hidden = true;
    // A surface underneath may still own the scroll lock, so restore what it set.
    document.body.style.overflow = restoreOverflow;
  }

  function open(options = {}) {
    const {
      src,
      mediaType = "",
      title = "Evidence",
      subtitle = "",
      spatial = false,
      trim = null,
      actions = [],
    } = options;
    if (!root) build();
    teardown();
    titleNode.textContent = title;
    subtitleNode.textContent = subtitle;
    renderFooter(actions);
    if (root.hidden) restoreOverflow = document.body.style.overflow;
    root.hidden = false;
    document.body.style.overflow = "hidden";

    const kind = String(mediaType || "").toLowerCase();
    const isVideo = kind.startsWith("video") || /\.(mp4|mov|m4v|webm)$/i.test(String(src || ""));
    const isImage = kind.startsWith("image") || /\.(jpg|jpeg|png|webp|heic)$/i.test(String(src || ""));

    if (!src) {
      stage.innerHTML = `<div class="pano-doc"><strong>${escapeText(title)}</strong><p>${escapeText(subtitle || "This file has no viewable stream.")}</p></div>`;
      return;
    }

    if (!isVideo && !isImage) {
      stage.innerHTML = `<div class="pano-doc"><strong>${escapeText(title)}</strong><p>Documents open in a separate tab so the original file stays untouched.</p><a href="${escapeText(src)}" target="_blank" rel="noopener">Open document ↗</a></div>`;
      return;
    }

    const media = document.createElement(isVideo ? "video" : "img");
    // The sphere shader samples the file as a WebGL texture, which requires a
    // CORS-clean response. Flat playback does not, so the attribute is only set
    // when the file is actually rendered spatially.
    if (spatial) media.crossOrigin = "anonymous";
    if (isVideo) {
      media.playsInline = true;
      media.loop = true;
      media.muted = true;
      media.preload = "auto";
    }
    media.src = src;

    if (!spatial) {
      if (isVideo) {
        media.controls = true;
        media.muted = false;
        media.className = "pano-flat";
        seekToWindowStart(media, trim);
      }
      media.alt = title;
      stage.appendChild(media);
      session = { dispose: () => { if (isVideo) media.pause(); } };
      return;
    }

    hintNode = document.createElement("p");
    hintNode.className = "pano-hint";
    hintNode.textContent = "Drag to look around · pinch or scroll to zoom";
    stage.appendChild(hintNode);

    const start = () => {
      try {
        const sphere = startSphere(media, isVideo, layoutMarkerPins);
        session = {
          dispose: () => {
            sphere.dispose();
            if (isVideo) media.pause();
          },
        };
        mountMarkers(sphere, isVideo ? media : null, options);
        // Arriving from a findings row: land looking at the point that row is
        // about, not at whatever direction the capture happened to start in.
        const focused = markerState.list.find((marker) => marker.id === options.focusMarkerId);
        if (focused) {
          lookAtMarker(focused, true);
          openMarkerCard(focused);
        }
        if (isVideo) {
          const window360 = resolveTrim(trim, media);
          showTrimNote(window360);
          buildPlayback(media, window360);
          seekToWindowStart(media, window360);
          media.play().catch(() => {});
        }
      } catch (error) {
        console.error("360 viewer", error);
        stage.innerHTML = "";
        if (isVideo) {
          media.controls = true;
          media.className = "pano-flat";
          seekToWindowStart(media, trim);
        }
        stage.appendChild(media);
        const note = document.createElement("p");
        note.className = "pano-hint";
        note.textContent = "This device cannot render the 360 sphere. The flat original is shown instead.";
        stage.appendChild(note);
        session = { dispose: () => { if (isVideo) media.pause(); } };
      }
    };

    if (isVideo) media.addEventListener("loadeddata", start, { once: true });
    else media.addEventListener("load", start, { once: true });
    media.addEventListener("error", () => {
      if (media.crossOrigin) {
        // The storage bucket did not return CORS headers. The evidence still has
        // to be viewable, so fall back to flat playback of the same original.
        stage.innerHTML = "";
        const flat = document.createElement(isVideo ? "video" : "img");
        flat.src = src;
        flat.alt = title;
        if (isVideo) {
          flat.controls = true;
          flat.playsInline = true;
          flat.className = "pano-flat";
          seekToWindowStart(flat, trim);
        }
        stage.appendChild(flat);
        const note = document.createElement("p");
        note.className = "pano-hint";
        note.textContent = "Spatial playback needs cross-origin access to the storage bucket. The flat original is shown instead.";
        stage.appendChild(note);
        session = { dispose: () => { if (isVideo) flat.pause(); } };
        return;
      }
      stage.innerHTML = `<div class="pano-doc"><strong>The file could not be loaded</strong><p>The secure link may have expired. Reopen the project and try again.</p></div>`;
    }, { once: true });
  }

  window.MDAIPano360 = { open, close };
})();

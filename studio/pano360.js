/* Measured Decision · 360 evidence viewer.

   A dependency-free equirectangular viewer. It renders a full-screen quad and
   resolves the view direction per pixel, so no sphere mesh or external 3D
   library is required. Photos, equirectangular MP4 exports, and non-spatial
   media all open through the same entry point, which keeps "open the evidence"
   a single action everywhere in the Studio.

   window.MDAIPano360.open({ src, mediaType, title, subtitle, projection, actions })
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
    @media(max-width:640px){.pano-bar small{display:none}}
  `;

  let root = null;
  let stage = null;
  let footer = null;
  let titleNode = null;
  let subtitleNode = null;
  let hintNode = null;
  let gyroButton = null;
  let playback = null;
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

  function startSphere(media, isVideo) {
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

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
      gl.uniform1f(uniforms.aspect, canvas.width / Math.max(1, canvas.height));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
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

    return () => {
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
  }

  function hide(node) {
    if (!node) return;
    node.style.opacity = "0";
    window.setTimeout(() => node.remove(), 400);
  }

  function buildPlayback(video) {
    playback = document.createElement("div");
    playback.className = "pano-playback";
    playback.innerHTML = `<button type="button" data-pano-play aria-label="Play or pause">▶</button><input type="range" min="0" max="1000" value="0" step="1" aria-label="Playback position">`;
    stage.appendChild(playback);
    const button = playback.querySelector("[data-pano-play]");
    const range = playback.querySelector("input");
    button.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    video.addEventListener("play", () => { button.textContent = "❚❚"; });
    video.addEventListener("pause", () => { button.textContent = "▶"; });
    video.addEventListener("timeupdate", () => {
      if (!video.duration || range.dataset.seeking === "1") return;
      range.value = String(Math.round((video.currentTime / video.duration) * 1000));
    });
    range.addEventListener("pointerdown", () => { range.dataset.seeking = "1"; });
    range.addEventListener("change", () => {
      range.dataset.seeking = "0";
      if (video.duration) video.currentTime = (Number(range.value) / 1000) * video.duration;
    });
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
    if (!session) return;
    session.dispose?.();
    session = null;
    stage.innerHTML = "";
    playback = null;
  }

  function close() {
    teardown();
    root.hidden = true;
    // A surface underneath may still own the scroll lock, so restore what it set.
    document.body.style.overflow = restoreOverflow;
  }

  function open({ src, mediaType = "", title = "Evidence", subtitle = "", spatial = false, actions = [] } = {}) {
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
        const dispose = startSphere(media, isVideo);
        session = {
          dispose: () => {
            dispose();
            if (isVideo) media.pause();
          },
        };
        if (isVideo) {
          buildPlayback(media);
          media.play().catch(() => {});
        }
      } catch (error) {
        console.error("360 viewer", error);
        stage.innerHTML = "";
        if (isVideo) {
          media.controls = true;
          media.className = "pano-flat";
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

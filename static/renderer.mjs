export const LANE_COLORS = ["#79b9ff", "#bc9bff", "#72f0d0", "#ffbe7a"];
const LANE_DARK = ["#3265cf", "#7344c9", "#178e89", "#cf713e"];
const LABELS = ["D", "F", "J", "K"];
export const HIT_DURATION_MS = 520;

export function stageGeometry(width, height) {
  const inset = width * 0.12;
  return { inset, laneWidth: (width - inset * 2) / 4, line: height - 68 };
}

export function notePosition(note, engine, speed, height) {
  return stageGeometry(0, height).line - (note.time_ms - engine.effectiveMs) * speed / 1000;
}

export function hitEffects(engine) {
  if (!engine || engine.phase === "idle") return [];
  return engine.notes.flatMap((note) => {
    if (note.judgement === null) return [];
    const age = engine.audioMs - note.judgedAtMs;
    if (age < 0 || age >= HIT_DURATION_MS) return [];
    return [{
      lane: note.lane, kind: note.judgement, age,
      progress: age / HIT_DURATION_MS,
      strength: 1 - age / HIT_DURATION_MS,
    }];
  });
}

function rounded(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function gradient(ctx, x1, y1, x2, y2, stops) {
  const paint = ctx.createLinearGradient(x1, y1, x2, y2);
  for (const [position, color] of stops) paint.addColorStop(position, color);
  return paint;
}

function drawNote(ctx, x, y, width, lane, reducedMotion) {
  const color = LANE_COLORS[lane];
  if (!reducedMotion) {
    ctx.fillStyle = gradient(ctx, 0, y - 84, 0, y, [[0, `${color}00`], [1, `${color}32`]]);
    ctx.beginPath();
    ctx.moveTo(x + width * .18, y - 84);
    ctx.lineTo(x + width * .82, y - 84);
    ctx.lineTo(x + width, y);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = gradient(ctx, 0, y - 90, 0, y, [[0, `${color}00`], [1, `${color}a0`]]);
    ctx.fillRect(x + width / 2 - .5, y - 90, 1, 80);
  }
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = reducedMotion ? 0 : 14;
  ctx.fillStyle = gradient(ctx, x, y - 10, x + width, y + 10, [
    [0, LANE_DARK[lane]], [.38, color], [.68, "#efffff"], [1, color],
  ]);
  rounded(ctx, x, y - 9, width, 18, 5);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `${color}d0`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = gradient(ctx, 0, y - 9, 0, y + 9, [[0, "#ffffffb0"], [.45, "#ffffff00"], [1, "#03163360"]]);
  ctx.fill();
  ctx.fillStyle = "#f2ffffb0";
  rounded(ctx, x + 5, y - 7, Math.max(1, width - 10), 2, 1);
  ctx.fill();
  ctx.fillStyle = "#ffffffcc";
  ctx.beginPath();
  ctx.moveTo(x + width / 2, y - 3);
  ctx.lineTo(x + width / 2 + 3, y);
  ctx.lineTo(x + width / 2, y + 3);
  ctx.lineTo(x + width / 2 - 3, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHit(ctx, x, line, laneWidth, effect, reducedMotion) {
  const color = effect.kind === "miss" ? "#ff8caa" : LANE_COLORS[effect.lane];
  const center = x + laneWidth / 2;
  ctx.save();
  ctx.globalAlpha = effect.strength;
  if (reducedMotion || effect.kind === "miss") {
    ctx.fillStyle = `${color}36`;
    rounded(ctx, x + 6, line - 12, laneWidth - 12, 24, 6);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.fillStyle = gradient(ctx, 0, line - 170, 0, line + 12, [[0, `${color}00`], [.8, `${color}18`], [1, `${color}90`]]);
  ctx.fillRect(x + 4, line - 170, laneWidth - 8, 185);
  ctx.shadowColor = color;
  ctx.shadowBlur = 18 * effect.strength;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * effect.strength + .5;
  ctx.beginPath();
  ctx.ellipse(center, line, laneWidth * (.22 + effect.progress * .58), 8 + effect.progress * 25, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = gradient(ctx, x, line, x + laneWidth, line, [[0, `${color}00`], [.5, "#e8ffff"], [1, `${color}00`]]);
  ctx.fillRect(x - 5, line - 2, laneWidth + 10, 4);
  ctx.shadowBlur = 0;
  for (let particle = 0; particle < 10; particle += 1) {
    const angle = Math.PI + particle / 9 * Math.PI;
    const distance = 10 + effect.progress * (36 + particle % 3 * 15);
    const px = center + Math.cos(angle) * distance * Math.min(1, laneWidth / 90);
    const py = line + Math.sin(angle) * distance - effect.progress * 12;
    ctx.strokeStyle = particle % 2 ? "#edffff" : color;
    ctx.lineWidth = particle % 2 ? 1.5 : 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(angle) * 5, py + Math.sin(angle) * 5);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawStage(ctx, width, height, engine, speed, reducedMotion = false) {
  if (width <= 0 || height <= 0) return;
  const { inset, laneWidth, line } = stageGeometry(width, height);
  const time = engine?.effectiveMs ?? 0;
  const running = engine?.phase === "running";
  const effects = hitEffects(engine);
  const beatMs = 60000 / (engine?.chart.bpm ?? 120);
  const beat = !reducedMotion && running && time >= 0
    ? (1 - ((time % beatMs) / beatMs)) * .08 : 0;
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = gradient(ctx, 0, 0, 0, height, [[0, "#060c1ec0"], [.5, "#070e1ee6"], [1, "#081126f0"]]);
  ctx.fillRect(0, 0, width, height);
  for (let star = 0; star < 26; star += 1) {
    const x = ((star * 73 + 19) % 997) / 997 * width;
    const y = ((star * 43 + 11) % 499) / 499 * (height - 100);
    ctx.fillStyle = star % 3 ? "#829fc040" : "#99d1ed60";
    ctx.fillRect(x, y, star % 3 ? 1 : 2, 1);
  }
  for (let lane = 0; lane < 4; lane += 1) {
    const x = inset + lane * laneWidth;
    const color = LANE_COLORS[lane];
    const pressed = engine?.pressed.has(lane);
    const hit = effects.filter((effect) => effect.lane === lane && effect.kind !== "miss")
      .reduce((strength, effect) => Math.max(strength, effect.strength), 0);
    const glow = Math.min(1, (pressed ? .48 : .1) + hit * .5 + beat);
    ctx.globalAlpha = glow;
    ctx.fillStyle = gradient(ctx, 0, 38, 0, line + 10, [[0, `${color}00`], [.65, `${color}12`], [1, `${color}80`]]);
    ctx.fillRect(x + 2, 38, laneWidth - 4, line - 28);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = gradient(ctx, 0, 30, 0, line, [[0, `${color}00`], [.4, `${color}18`], [1, `${color}60`]]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 1, 38);
    ctx.lineTo(x + 1, line + 10);
    ctx.moveTo(x + laneWidth - 1, 38);
    ctx.lineTo(x + laneWidth - 1, line + 10);
    ctx.stroke();
    const pad = Math.min(10, laneWidth * .14);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = reducedMotion ? 0 : 10 + hit * 12;
    ctx.fillStyle = gradient(ctx, x + pad, line, x + laneWidth - pad, line, [[0, `${color}60`], [.5, "#e1ffff"], [1, `${color}60`]]);
    rounded(ctx, x + pad, line - 2, laneWidth - pad * 2, 4, 2);
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = gradient(ctx, 0, line + 15, 0, height - 8, [[0, `${color}25`], [1, `${color}05`]]);
    rounded(ctx, x + pad, line + 14, laneWidth - pad * 2, 42, 8);
    ctx.fill();
    ctx.strokeStyle = `${color}${pressed || hit > .3 ? "b0" : "40"}`;
    ctx.stroke();
    ctx.font = `600 ${Math.min(18, laneWidth * .28)}px Segoe UI`;
    ctx.textAlign = "center";
    ctx.fillStyle = pressed ? "#ffffff" : color;
    ctx.fillText(LABELS[lane], x + laneWidth / 2, line + 41);
  }
  const spacing = Math.max(55, speed * beatMs / 1000);
  const scroll = engine?.phase === "idle" || reducedMotion ? 0 : ((time * speed / 1000) % spacing + spacing) % spacing;
  ctx.strokeStyle = "#b0c5ff0d";
  ctx.lineWidth = 1;
  for (let y = line - spacing + scroll; y > 40; y -= spacing) {
    ctx.beginPath();
    ctx.moveTo(inset, y);
    ctx.lineTo(width - inset, y);
    ctx.stroke();
  }
  ctx.fillStyle = gradient(ctx, 0, line - 28, 0, line + 34, [[0, "#8db8ff00"], [.5, "#8db8ff14"], [1, "#8db8ff00"]]);
  ctx.fillRect(inset - 12, line - 28, laneWidth * 4 + 24, 62);
  if (engine?.phase === "idle") {
    ctx.globalAlpha = .3;
    for (let lane = 0; lane < 4; lane += 1) {
      const pad = Math.min(10, laneWidth * .14);
      drawNote(ctx, inset + lane * laneWidth + pad, line - 115 - (lane % 3) * 62, laneWidth - pad * 2, lane, reducedMotion);
    }
    ctx.globalAlpha = 1;
  } else if (engine) {
    for (const note of engine.notes) {
      if (note.judgement !== null) continue;
      const y = notePosition(note, engine, speed, height);
      if (y < -20) break;
      if (y > height + 20) continue;
      const pad = Math.min(10, laneWidth * .14);
      drawNote(ctx, inset + note.lane * laneWidth + pad, y, laneWidth - pad * 2, note.lane, reducedMotion);
    }
  }
  for (const effect of effects) {
    drawHit(ctx, inset + effect.lane * laneWidth, line, laneWidth, effect, reducedMotion);
  }
  if (running && engine.audioMs < 0 && !reducedMotion) {
    const launch = 1 - (((engine.audioMs % 1000) + 1000) % 1000) / 1000;
    ctx.globalAlpha = launch * .16;
    ctx.strokeStyle = "#a3c9ff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(width / 2, height * .42, width * (.15 + (1 - launch) * .3), height * (.1 + (1 - launch) * .2), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

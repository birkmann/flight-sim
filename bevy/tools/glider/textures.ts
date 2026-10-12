/** Canvas-generated textures embedded in the glider GLB (registration lettering, instrument panel). */

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("canvas.toBlob failed");
  return new Uint8Array(await blob.arrayBuffer());
}

/** Registration lettering on transparent background. `aspect` = width / height of the decal patch. */
export async function registrationTexture(text: string, aspect: number): Promise<Uint8Array> {
  const W = 1024;
  const H = Math.round(W / aspect / 4) * 4;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  const capH = H * 0.86;
  // DIN-ish condensed sans as found on German glider registrations
  g.font = `700 ${Math.round(capH / 0.72)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  g.textBaseline = "alphabetic";
  const m = g.measureText(text);
  const sx = Math.min(1.25, (W * 0.98) / m.width);
  g.save();
  g.translate(W / 2, H / 2 + capH / 2);
  g.scale(sx, 1);
  g.fillStyle = "#14171c";
  g.textAlign = "center";
  g.fillText(text, 0, 0);
  g.restore();
  return canvasPng(c);
}

/** Instrument panel face: dark panel, round gauges, a moving-map flight computer in the middle. */
export async function panelTexture(): Promise<Uint8Array> {
  const W = 512;
  const H = 256;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#2a2d31");
  bg.addColorStop(1, "#1a1c1f");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const gauge = (x: number, y: number, r: number, needle: number) => {
    g.fillStyle = "#0b0c0e";
    g.beginPath();
    g.arc(x, y, r + 4, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#5b6067";
    g.lineWidth = 3;
    g.stroke();
    g.strokeStyle = "#d8dde3";
    g.lineWidth = 2;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const r0 = k % 3 === 0 ? r * 0.72 : r * 0.84;
      g.beginPath();
      g.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
      g.lineTo(x + Math.cos(a) * r * 0.95, y + Math.sin(a) * r * 0.95);
      g.stroke();
    }
    g.strokeStyle = "#ffffff";
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(needle) * r * 0.8, y + Math.sin(needle) * r * 0.8);
    g.stroke();
  };
  gauge(70, 92, 46, -2.2);
  gauge(70, 196, 40, 0.4);
  gauge(442, 92, 46, -0.6);
  gauge(442, 196, 40, -1.4);
  // flight computer
  g.fillStyle = "#08090b";
  g.fillRect(148, 36, 216, 170);
  const scr = g.createLinearGradient(0, 44, 0, 196);
  scr.addColorStop(0, "#1d4e6e");
  scr.addColorStop(1, "#16384f");
  g.fillStyle = scr;
  g.fillRect(156, 44, 200, 150);
  g.strokeStyle = "#7fd0ff";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(180, 170);
  g.lineTo(250, 80);
  g.lineTo(330, 150);
  g.stroke();
  g.fillStyle = "#ffd25a";
  g.beginPath();
  g.arc(256, 140, 6, 0, Math.PI * 2);
  g.fill();
  // small buttons / switches
  g.fillStyle = "#3a3e44";
  for (let k = 0; k < 5; k++) g.fillRect(170 + k * 38, 218, 22, 14);
  return canvasPng(c);
}

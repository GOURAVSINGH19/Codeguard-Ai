// Renders docs/demo/demo.html frame by frame with headless Chrome, then encodes
// codeguard-demo.mp4 and codeguard-demo.gif with ffmpeg.
//
// Usage (needs ffmpeg on PATH and a local Chrome or Edge):
//   npm i --no-save puppeteer-core
//   node docs/demo/record.cjs
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const puppeteer = require("puppeteer-core");

const FPS = 30;
const dir = __dirname;
const frames = fs.mkdtempSync(path.join(os.tmpdir(), "codeguard-frames-"));

const chrome = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => p && fs.existsSync(p));

(async () => {
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.goto("file:///" + path.join(dir, "demo.html").replace(/\\/g, "/") + "?record");
  const total = await page.evaluate(() => window.TOTAL);
  const count = Math.round(total * FPS);
  const stage = await page.$("#stage");

  for (let i = 0; i < count; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    await stage.screenshot({ path: path.join(frames, `f${String(i).padStart(5, "0")}.png`) });
    if (i % 150 === 0) console.log(`frame ${i}/${count}`);
  }
  await browser.close();

  const input = path.join(frames, "f%05d.png");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart",
    path.join(dir, "codeguard-demo.mp4")], { stdio: "inherit" });
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", input,
    "-vf", "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    path.join(dir, "codeguard-demo.gif")], { stdio: "inherit" });

  fs.rmSync(frames, { recursive: true, force: true });
  console.log("done:", total.toFixed(1) + "s");
})();

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  Menu,
  MenuItem,
  dialog,
  shell,
  desktopCapturer,
  clipboard,
} = require("electron");
const path = require("path");
const fsPromises = require("fs").promises;
const fs = require("fs");
const axios = require("axios");
const https = require("https");
const http = require("http");
const Store = require("electron-store");
const os = require("os");
const { readdirSync } = require("fs");
const { spawn } = require("child_process");
const NodeCache = require("node-cache");
const { lock } = require("proper-lockfile");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static"); 



// ฟังก์ชันกำหนดพาธของ ffmpeg
const getFfmpegPath = () => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "ffmpeg.exe");
  } else {
    return ffmpegStatic;
  }
};

// กำหนด ffmpegPath เป็นตัวแปร global
const ffmpegPath = getFfmpegPath();
ffmpeg.setFfmpegPath(ffmpegPath);

const ytDlpPath = app.isPackaged
    ? path.join(process.resourcesPath, "yt-dlp.exe")
    : path.join(__dirname, "resources", "yt-dlp.exe");

if (!fs.existsSync(ytDlpPath)) {
    const errorMsg = app.isPackaged
        ? `yt-dlp.exe not found in packaged resources at: ${ytDlpPath}`
        : `yt-dlp.exe not found in development resources at: ${ytDlpPath}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
}



const cache = new NodeCache({
  stdTTL: 10,
  checkperiod: 5,
  useClones: false,
});

const axiosInstance = axios.create({
    httpsAgent: new https.Agent({
        rejectUnauthorized: false,
    }),
})

const store = new Store({
  cwd: app.getPath("userData"),
});

const userDataPath = app.getPath("userData");
const channelsFilePath = path.join(userDataPath, "channels.js");
const logFilePath = path.join(userDataPath, "app.log");

app.disableHardwareAcceleration();

let mainWindow;
let currentLanguage = store.get("currentLanguage", "th");
let serverPort;
let server;
let proxy;
let restartTimeout;
let aboutWindow = null;

const CURRENT_VERSION = app.getVersion();
const UPDATE_CHECK_URL = "https://www.yourserver.com/update.json";
const CACHE_DURATION = 10 * 60 * 1000;

function log(message, level = "info") {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
  console[level](message);
  fs.appendFileSync(logFilePath, logMessage);
}

function showError(message) {
  log(message, "error");
  dialog.showErrorBox("Error", message);
}

async function ensureChannelsFileExists() {
  const dir = path.dirname(channelsFilePath);
  const defaultChannelsPath = path.join(__dirname, "src", "channels.js");

  try {
    if (!fs.existsSync(dir)) {
      await fsPromises.mkdir(dir, { recursive: true });
      log(`Created directory: ${dir}`);
    }
    if (!fs.existsSync(channelsFilePath)) {
      await fsPromises.copyFile(defaultChannelsPath, channelsFilePath);
      log(`Copied default channels.js to: ${channelsFilePath}`);
    } else {
      log(`channels.js already exists at: ${channelsFilePath}`);
    }
  } catch (error) {
    log(`Failed to ensure channels.js exists: ${error.message}`, "error");
    showError(`Cannot create channels.js: ${error.message}`);
    throw error;
  }
}

let channelsCache = {
  data: null,
  timestamp: 0,
  maxSize: 2000,
};

function getImportedFiles() {
  return store.get("importedFiles", []);
}

function addImportedFile(filePath, fileType) {
  const importedFiles = getImportedFiles();
  const fileEntry = {
    path: filePath,
    type: fileType,
    name: path.basename(filePath),
  };
  if (!importedFiles.some((f) => f.path === filePath)) {
    importedFiles.push(fileEntry);
    store.set("importedFiles", importedFiles);
    log(`Added imported file: ${filePath}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("imported-files-updated", importedFiles);
    }
  }
  return importedFiles;
}

function removeImportedFile(filePath) {
  let importedFiles = getImportedFiles();
  const fileToRemove = importedFiles.find((f) => f.path === filePath);

  if (fileToRemove) {
    try {
      log(`กำลังลบไฟล์ที่นำเข้า: ${filePath}`);
      importedFiles = importedFiles.filter((f) => f.path !== filePath);
      store.set("importedFiles", importedFiles);

      if (store.get("lastChannelsPath") === filePath) {
        store.delete("lastChannelsPath");
        ensureChannelsFileExists();
        log(`สร้าง channels.js ใหม่เนื่องจากไฟล์ที่ใช้งานอยู่ถูกลบ`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("channels-updated", []);
        }
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("imported-files-updated", importedFiles);
      }
    } catch (error) {
      log(
        `ไม่สามารถลบไฟล์ ${filePath} จากรายการนำเข้า: ${error.message}`,
        "error",
      );
      showError(`ไม่สามารถลบไฟล์: ${error.message}`);
    }
  } else {
    log(`ไม่พบไฟล์ ${filePath} ในรายการนำเข้า`, "warn");
  }
  return importedFiles;
}

function isCacheValid(timestamp) {
  return Date.now() - timestamp < CACHE_DURATION;
}

async function loadChannelsFile() {
  try {
    await ensureChannelsFileExists(); // เรียกก่อนเพื่อให้แน่ใจว่าไฟล์มีอยู่

    if (!fs.existsSync(channelsFilePath)) {
      log(`Channels file still not found after ensure at ${channelsFilePath}`, "error");
      channelsCache = { data: [], timestamp: Date.now(), maxSize: channelsCache.maxSize };
      return channelsCache.data;
    }

    delete require.cache[require.resolve(channelsFilePath)];
    const channels = require(channelsFilePath);

    if (!Array.isArray(channels)) {
      log(`Channels file is not an array, resetting to empty array`, "error");
      await fsPromises.writeFile(channelsFilePath, `module.exports = [];`);
      channelsCache = { data: [], timestamp: Date.now(), maxSize: channelsCache.maxSize };
      return channelsCache.data;
    }

    channelsCache = {
      data: channels.slice(0, channelsCache.maxSize),
      timestamp: Date.now(),
      maxSize: channelsCache.maxSize,
    };
    log(`Loaded and cached channels: ${channelsCache.data.length} items`);
    return channelsCache.data;
  } catch (error) {
    log(`Failed to load channels file: ${error.message}`, "error");
    // ถ้ามีข้อผิดพลาด ให้สร้างไฟล์ใหม่และคืนค่า array ว่าง
    await fsPromises.writeFile(channelsFilePath, `module.exports = [];`);
    channelsCache = { data: [], timestamp: Date.now(), maxSize: channelsCache.maxSize };
    return channelsCache.data;
  }
}


async function getYouTubeFormats(videoId) {
    return new Promise((resolve, reject) => {
        console.log(`Spawning yt-dlp at: ${ytDlpPath} for videoId: ${videoId}`);
        const ytDlp = spawn(ytDlpPath, ["-j", `https://www.youtube.com/watch?v=${videoId}`]);
        let output = "";
        ytDlp.stdout.on("data", (data) => {
            output += data;
            console.log("yt-dlp stdout:", data.toString());
        });
        ytDlp.stderr.on("data", (data) => console.error(`yt-dlp error: ${data}`));
        ytDlp.on("error", (err) => {
            console.error("Failed to spawn yt-dlp:", err.message);
            reject(new Error("yt-dlp not found or failed to execute"));
        });
        ytDlp.on("close", (code) => {
            console.log(`yt-dlp process exited with code: ${code}`);
            if (code === 0) {
                const info = JSON.parse(output);
                const formats = info.formats
                    .filter((f) => f.vcodec !== "none" && f.acodec !== "none")
                    .map((f) => ({
                        formatId: f.format_id,
                        resolution: f.resolution || `${f.height}p`,
                        url: f.url,
                        ext: f.ext,
                    }));
                resolve({ title: info.title, formats });
            } else {
                reject(new Error(`yt-dlp exited with code ${code}`));
            }
        });
    });
}

ipcMain.handle("get-youtube-formats", async (event, videoId) => {
    return await getYouTubeFormats(videoId);
});

ipcMain.handle("download-youtube", async (event, { videoId, formatId, outputPath }) => {
    const { formats } = await getYouTubeFormats(videoId); // เรียกฟังก์ชันภายในโดยตรง
    const selectedFormat = formats.find((f) => f.formatId === formatId);
    if (!selectedFormat) throw new Error(`Format ${formatId} not found`);

    return new Promise((resolve, reject) => {
        const command = ffmpeg(selectedFormat.url)
            .outputOptions(["-c:v copy", "-c:a copy", "-f mp4"])
            .output(outputPath)
            .on("start", (commandLine) => console.log(`FFmpeg command: ${commandLine}`))
            .on("progress", (progress) => {
                const percent = progress.percent ? progress.percent.toFixed(2) : ((progress.frames / 1000) * 100).toFixed(2);
                mainWindow.webContents.send("download-progress", {
                    percent: Math.min(percent, 100),
                    timemark: progress.timemark,
                });
            })
            .on("end", () => {
                console.log(`YouTube video downloaded to ${outputPath}`);
                mainWindow.webContents.send("download-complete", outputPath);
                resolve(outputPath);
            })
            .on("error", (err) => {
                console.error(`FFmpeg error: ${err.message}`);
                mainWindow.webContents.send("download-error", err.message);
                reject(err);
            });

        command.run();
    });
});



let currentFmpegCommand = null;
ipcMain.handle("download-video", async (event, { url, outputPath, duration }) => {
    try {
        log(`Starting video download from ${url} to ${outputPath} with duration ${duration !== null ? duration : 'unlimited'} seconds`);

        let realUrl = url;
        let referer = null;
        let userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36";

        // โหลด channels.js
        const channels = await loadChannelsFile();
        log(`Loaded ${channels.length} channels from channels.js`);

        // จัดการ Proxy ก่อนค้นหา Referer
        if (url.includes("localhost") && url.includes("/m3u8?url=")) {
            const urlParams = new URLSearchParams(url.split("?")[1]);
            realUrl = urlParams.get("url");
            log(`Converted proxy URL to real URL: ${realUrl}`);
        } else if (url.includes("localhost") && proxyServerInstance) {
            realUrl = await proxyServerInstance.fetchM3u8(realUrl);
            log(`Fetched real .m3u8 URL from proxy: ${realUrl}`);
        }

        // ค้นหา Referer และ User-Agent โดยใช้ realUrl
        const channel = channels.find(ch => ch.file === realUrl || realUrl.includes(ch.file));
        if (channel) {
            if (channel.httpOptions && channel.httpOptions.referrer) {
                referer = channel.httpOptions.referrer;
                log(`Using channel-specific Referer from channels.js: ${referer}`);
            }
            if (channel.httpOptions && channel.httpOptions.userAgent) {
                userAgent = channel.httpOptions.userAgent;
                log(`Using channel-specific User-Agent from channels.js: ${userAgent}`);
            }
        } else {
            log(`No matching channel found in channels.js for URL: ${realUrl}`);
            referer = "https://99dooball.com/"; // ใช้ Referer จาก channels.js เป็น fallback
            log(`Falling back to guessed Referer: ${referer}`);
        }

        if (!realUrl.endsWith(".m3u8")) {
            throw new Error("Only HLS (.m3u8) streams are supported for download");
        }

        log(`Using ffmpeg at: ${ffmpegPath}`);

        return new Promise((resolve, reject) => {
            const command = ffmpeg(realUrl)
                .inputOptions([
                    "-live_start_index 0",
                    `-headers`, `Referer: ${referer}\r\nUser-Agent: ${userAgent}\r\n`,
                    ...(duration !== null && duration > 0 ? [`-t ${duration}`] : [])
                ])
                .outputOptions([
                    "-c:v copy",
                    "-c:a aac",
                    "-b:a 128k",
                    "-f mp4",
                    "-movflags frag_keyframe+empty_moov+faststart"
                ])
                .output(outputPath)
                .on("start", (commandLine) => {
                    log(`FFmpeg command started: ${commandLine}`);
                    currentFmpegCommand = command;
                })
                .on("progress", (progress) => {
                    const currentTime = parseTimeToSeconds(progress.timemark);
                    const percent = duration ? (currentTime / duration) * 100 : currentTime / 3600 * 100;
                    log(`Download progress: ${percent.toFixed(2)}% - ${progress.timemark}`);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send("download-progress", {
                            percent: Math.min(percent.toFixed(2), 100),
                            timemark: progress.timemark,
                        });
                    }
                    if (duration && currentTime >= duration) {
                        log(`Duration ${duration} seconds reached, stopping download`);
                        command.kill("SIGTERM");
                    }
                })
                .on("end", () => {
                    log(`Video downloaded successfully to ${outputPath}`);
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send("download-complete", outputPath);
                    }
                    currentFmpegCommand = null;
                    resolve(outputPath);
                })
                .on("error", (err) => {
                    if (err.message.includes("SIGTERM") || err.message.includes("SIGKILL")) {
                        log(`FFmpeg stopped with signal, treating as successful stop`);
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send("download-complete", outputPath);
                        }
                        currentFmpegCommand = null;
                        resolve(outputPath);
                    } else {
                        log(`FFmpeg error: ${err.message}`, "error");
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send("download-error", err.message);
                        }
                        currentFmpegCommand = null;
                        reject(err);
                    }
                });

            command.run();
            log("FFmpeg command run initiated");
        });
    } catch (error) {
        log(`Download initiation failed: ${error.message}`, "error");
        throw error;
    }
});

ipcMain.handle("stop-download", async () => {
  if (currentFmpegCommand) {
    try {
      const outputPath = currentFmpegCommand._outputs[0].target;
      log(`Stopping download, output path: ${outputPath}`);

      // ลอง SIGTERM ก่อน
      currentFmpegCommand.kill("SIGTERM");
      log("Attempted to stop with SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 500)); // รอสั้นลงเป็น 0.5 วินาที

      // ตรวจสอบว่า ffmpeg หยุดหรือยัง
      if (currentFmpegCommand && currentFmpegCommand.ffmpegProc && !currentFmpegCommand.ffmpegProc.killed) {
        log("SIGTERM failed, forcing stop with SIGKILL");
        currentFmpegCommand.kill("SIGKILL");
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      log("Download stopped by user");
      currentFmpegCommand = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("download-complete", outputPath);
      }
      return true;
    } catch (error) {
      log(`Failed to stop download: ${error.message}`, "error");
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        log(`Deleted incomplete file: ${outputPath}`);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("download-error", error.message);
      }
      currentFmpegCommand = null;
      return false;
    }
  } else {
    log("No active download to stop");
    return false;
  }
});

function parseTimeToSeconds(timemark) {
  const [hours, minutes, seconds] = timemark.split(":").map(parseFloat);
  return (hours * 3600) + (minutes * 60) + seconds;
}
async function convertToMp4(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    log(`Starting conversion from ${inputPath} to ${outputPath}`);
    ffmpeg(inputPath)
      .outputOptions(["-c copy", "-bsf:a aac_adtstoasc"])
      .output(outputPath)
      .on("end", () => {
        log(`Converted ${inputPath} to ${outputPath}`);
        fs.unlinkSync(inputPath);
        resolve();
      })
      .on("error", (err) => {
        log(`Conversion error: ${err.message}`, "error");
        reject(err);
      })
      .run();
  });
}
ipcMain.handle("show-save-dialog", async (event, options) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log("Main window is not available", "error");
    return { canceled: true };
  }

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: options.defaultPath,
    filters: options.filters || [{ name: "All Files", extensions: ["*"] }],
  });

  log(`Save dialog result: ${JSON.stringify(result)}`);
  return result;
});


ipcMain.on("set-channels", async (event, updatedChannels) => {
  const release = await lock(channelsFilePath); // บรรทัด 190
  try {
    log(`Saving ${updatedChannels.length} channels, first channel DRM: ${JSON.stringify(updatedChannels[0]?.drm)}`);
    await fsPromises.writeFile(
      channelsFilePath,
      `module.exports = ${JSON.stringify(updatedChannels, null, 2)};`
    );
    channelsCache = {
      data: updatedChannels,
      timestamp: Date.now(),
      maxSize: channelsCache.maxSize,
    };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("channels-updated", updatedChannels);
    }
  } catch (error) {
    log(`Failed to save updated channels: ${error.message}`, "error");
    showError(`Failed to save updated channels: ${error.message}`);
  } finally {
    await release();
  }
});

ipcMain.handle("open-folder-dialog", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showError("Main window is not available");
    return null;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    filters: [
      {
        name: "Media Files",
        extensions: [
          "mp3",
          "mp4",
          "m4a",
          "m4v",
          "mov",
          "webm",
          "flv",
          "avi",
          "mkv",
          "ts",
          "m3u8",
          "mpd",
          "aac",
          "ogg",
          "wav",
        ],
      },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (!result.canceled) {
    const folderPath = result.filePaths[0];
    log(`Selected folder: ${folderPath}`);

    try {
      const files = readdirSync(folderPath)
        .filter((file) =>
          /\.(mp3|mp4|m4a|m4v|mov|webm|flv|avi|mkv|ts|m3u8|mpd|aac|ogg|wav)$/i.test(
            file,
          ),
        )
        .map((file) => ({
          name: path.basename(file),
          file: path.join(folderPath, file),
          group: "Folder Media",
          logo: "assets/tv-app.png",
        }));
      log(`Found ${files.length} media files in folder: ${folderPath}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("folder-media-selected", files);
      }
      return files;
    } catch (error) {
      log(`Failed to read folder ${folderPath}: ${error.message}`, "error");
      showError(`Failed to read folder: ${error.message}`);
      return [];
    }
  }
  return [];
});




ipcMain.handle("get-channels", async () => {
  const channels = await loadChannelsFile();
  log(`Returning ${channels.length} channels to renderer, first channel DRM: ${JSON.stringify(channels[0]?.drm)}`);
  return channels;
});

let currentRefresher = null;
let serverInstance = null;

let proxyServerInstance = null;
let isProxyRunning = false;

function createServer(mainWindow) {
  if (proxyServerInstance && isProxyRunning) {
    log("[server] Proxy server already running");
    return proxyServerInstance;
  }

  const BASE_PORT = 9080;
  const MAX_PORT = 9100;
  let currentPort = BASE_PORT;
  let serverPort = null;
  let currentChannelUrl = null;

  const tokenCache = new Map();

  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Transfer-Encoding", "chunked");

      const sendError = (status, message, isM3u8 = false) => {
        if (res.headersSent) {
          log(`[sendError] Headers already sent, cannot send error: ${status} - ${message}`, "warn");
          res.end();
          return;
        }
        res.writeHead(status, {
          "Content-Type": isM3u8 ? "application/vnd.apple.mpegurl" : "text/plain",
        });
        res.end(isM3u8 ? `#EXTM3U\n#EXT-X-ERROR: ${message}` : message);
        log(`[sendError] ส่งข้อผิดพลาด: ${status} - ${message}`, "error");
      };

      const getCustomHeaders = (channelUrl, channel = {}) => {
        const httpOptions = channel.httpOptions || {};
        const defaultReferer = "https://dookeela.live";
        const referer = httpOptions.referrer || defaultReferer;
        const origin = httpOptions.referrer ? new URL(httpOptions.referrer).origin : new URL(defaultReferer).origin;
        return {
          "User-Agent": httpOptions.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
          Referer: referer,
          Origin: origin,
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "identity",
          Connection: "keep-alive",
          "Keep-Alive": "timeout=15, max=1000",
          "X-Forwarded-For": "203.0.113.1", // เพิ่ม header เพื่อเลียนแบบ client IP
        };
      };

      const CACHE_DURATION = 1000;

      const refreshStreamUrl = async (channelUrl, channel) => {
        log(`[refreshStreamUrl] ขอ URL ใหม่สำหรับ: ${channelUrl}`);
        try {
          const response = await axiosInstance.get(channelUrl, {
            headers: getCustomHeaders(channelUrl, channel),
            timeout: 15000, // เพิ่ม timeout เป็น 15 วินาที
          });
          const newM3u8Url = extractM3u8FromContent(response.data, channelUrl);
          log(`[refreshStreamUrl] ได้ URL ใหม่: ${newM3u8Url}`);
          return newM3u8Url;
        } catch (error) {
          log(`[refreshStreamUrl] ไม่สามารถขอ URL ใหม่: ${error.message}`, "error");
          throw error;
        }
      };

      const fetchContent = async (fetchUrl, isTs = false, channel = {}, retries = 5, originalChannelUrl = null) => {
        log(`[fetchContent] เริ่มดึงข้อมูล: ${fetchUrl}, retries left: ${retries}`);
        const cachedData = cache.get(fetchUrl);
        const cacheTtl = cache.getTtl(fetchUrl) || 0;
        const cacheAge = Date.now() - cacheTtl;

        if (cachedData && cacheAge < CACHE_DURATION && !isTs) {
          log(`[fetchContent] ใช้แคชที่มีอายุ ${cacheAge}ms สำหรับ: ${fetchUrl}`);
          return cachedData;
        }

        const headers = getCustomHeaders(fetchUrl, channel);

        let delay = 500;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const response = await axiosInstance({
              method: "get",
              url: fetchUrl,
              headers,
              timeout: 15000, // เพิ่ม timeout เป็น 15 วินาที
              responseType: isTs ? "stream" : "text",
              maxRedirects: 5,
            });

            if (isTs) {
              if (res.headersSent) {
                log(`[fetchContent] Headers already sent for .ts: ${fetchUrl}, skipping stream`, "warn");
                return;
              }
              res.writeHead(200, { "Content-Type": "video/MP2T" });
              response.data.pipe(res);
              return new Promise((resolve, reject) => {
                response.data.on("end", () => {
                  log(`[fetchContent] สตรีม .ts สำเร็จ: ${fetchUrl}`);
                  resolve();
                });
                response.data.on("error", (err) => {
                  log(`[fetchContent] สตรีม .ts ล้มเหลว: ${err.message}`, "error");
                  reject(err);
                });
              });
            } else {
              const content = response.data;
              cache.set(fetchUrl, content, CACHE_DURATION / 1000);

              const urlParams = new URLSearchParams(new URL(fetchUrl).search);
              const newNimbleSessionId = urlParams.get("nimblesessionid") || "";
              const newWmsAuthSign = urlParams.get("wmsAuthSign") || "";
              const tokenKey = `${newNimbleSessionId}|${newWmsAuthSign}`;
              const oldToken = tokenCache.get(originalChannelUrl || fetchUrl);

              if (tokenKey && oldToken && tokenKey !== oldToken) {
                log(`[fetchContent] ตรวจพบ token ใหม่: ${tokenKey} (เก่า: ${oldToken}), รีเฟรช URL`);
                const newM3u8Url = await refreshStreamUrl(originalChannelUrl || fetchUrl, channel);
                if (newM3u8Url !== fetchUrl) {
                  tokenCache.set(originalChannelUrl || fetchUrl, tokenKey);
                  return await fetchContent(newM3u8Url, isTs, channel, retries, originalChannelUrl);
                } else {
                  log(`[fetchContent] URL ใหม่เหมือนเดิม: ${newM3u8Url}, ไม่รีเฟรชซ้ำ`);
                  tokenCache.set(originalChannelUrl || fetchUrl, tokenKey);
                }
              } else if (tokenKey && !oldToken) {
                log(`[fetchContent] บันทึก token ใหม่: ${tokenKey}`);
                tokenCache.set(originalChannelUrl || fetchUrl, tokenKey);
              }

              log(`[fetchContent] ดึงข้อมูลสำเร็จ: ${fetchUrl}, HTTP ${response.status}, ขนาด: ${content.length}`);
              log(`[fetchContent] เนื้อหา .m3u8: ${content.substring(0, 500)}`); // Debug เนื้อหา
              return content;
            }
          } catch (error) {
            log(`[fetchContent] ดึง ${fetchUrl} ล้มเหลว (ครั้งที่ ${attempt + 1}): ${error.message}`, "error");

            // รีเฟรช URL ถ้า timeout หรือ 403/404
            if (attempt < retries && (error.code === "ECONNABORTED" || (error.response && [403, 404].includes(error.response.status)))) {
              log(`[fetchContent] Timeout หรือข้อผิดพลาด ${error.response?.status}, ลองรีเฟรช URL`);
              const newM3u8Url = await refreshStreamUrl(originalChannelUrl || fetchUrl, channel);
              if (newM3u8Url !== fetchUrl) {
                return await fetchContent(newM3u8Url, isTs, channel, retries - attempt - 1, originalChannelUrl);
              }
            }

            if (attempt === retries) {
              if (cachedData) {
                log(`[fetchContent] ใช้แคชสำรอง (อาจหมดอายุ) สำหรับ: ${fetchUrl}`);
                return cachedData;
              }
              throw error;
            }

            delay = Math.min(delay * 1.5, 5000);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      };

      const extractM3u8FromContent = (htmlContent, channelUrl) => {
       const m3u8UrlPatterns = [
  // Original patterns
  /https?:\/\/[^\s"']+?\.m3u8(?:\?[^\s"']*)?/iu,
  /(?:src|href)=["']?(https?:\/\/[^\s"']+?\.m3u8(?:\?[^\s"']*)?)["']?/iu,
  /https?:\/\/[^\s"']+?playlist\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?index\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?master\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?live\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?video\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?chunks\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?chunklist\.m3u8(?:\?[^\s"']*)?/iu,
  
  // First set of additional patterns
  /https?:\/\/[^\s"']+?stream[_-]?\d+\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?channel[_-]?\d+\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?[_-]?\d+p\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?[_-]?(?:low|medium|high|hd|sd|4k)\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/cdn[^\s"']+?\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?player[^\s"']+?m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?embed[^\s"']+?m3u8(?:\?[^\s"']*)?/iu,
  /data-[^=]+=["']?(https?:\/\/[^\s"']+?\.m3u8(?:\?[^\s"']*)?)["']?/iu,
  /['"](https?:\/\/[^\s"']+?\.m3u8(?:\?[^\s"']*)?)['"]/iu,
  /https?:\/\/[^\s"']+?\/api\/[^\s"']+?\.m3u8(?:\?[^\s"']*)?/iu,
  
  // More additional patterns
  /https?:\/\/[^\s"']+?manifest\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?hls[^\/]*?\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?segment[^\s"']*?\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?bitrate=\d+[^\s"']*?\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?token=[^\s"']+?\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?auth=[^\s"']+?\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?prog_index\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?media[_-]?\d*\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?subtitles[_-]?\d*\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?content[_-]?\d*\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?main[_-]?\d*\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?asset[_-]?\d*\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?vod\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?bandwidth=\d+[^\s"']*?\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?tracks[_-]v\d+\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?playlist_\d+\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?variant[_-]\d+\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?backup\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?fallback\.m3u8(?:\?[^\s"']*)?/iu,
  /https?:\/\/[^\s"']+?[_-]?(?:720|1080|480|360|240|144)\.m3u8(?:\?[^\s"']*)?/iu
];

let m3u8Url = null;
        for (const pattern of m3u8UrlPatterns) {
          const match = htmlContent.match(pattern);
          if (match) {
            m3u8Url = match[1] || match[0];
            break;
          }
        }
        if (!m3u8Url) {
          log(`[extractM3u8] ไม่พบ .m3u8 URL ใน ${channelUrl}, เนื้อหา: ${htmlContent.substring(0, 2000)}`, "warn");
          throw new Error("ไม่พบ URL .m3u8 ในเนื้อหา");
        }
        log(`[extractM3u8] พบ .m3u8 URL: ${m3u8Url}`);
        return m3u8Url;
      };

      if (req.url.startsWith("/m3u8?")) {
        const params = new URLSearchParams(req.url.slice(6));
        const channelUrl = params.get("url");
        if (!channelUrl) return sendError(400, "ไม่มีพารามิเตอร์ url", true);

        const channels = channelsCache.data || [];
        const channel = channels.find(ch => ch.file === channelUrl) || {};

        log(`[m3u8] ประมวลผลคำขอ m3u8 สำหรับ: ${channelUrl}`);
        try {
          let m3u8Url = channelUrl;
          let baseUrl;
          let m3u8Content;

          const content = await fetchContent(channelUrl, false, channel, 5, channelUrl);
          if (content.includes("#EXTM3U")) {
            m3u8Content = content;
            baseUrl = channelUrl.substring(0, channelUrl.lastIndexOf("/") + 1);
          } else {
            m3u8Url = await extractM3u8FromContent(content, channelUrl);
            m3u8Content = await fetchContent(m3u8Url, false, channel, 5, channelUrl);
            baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf("/") + 1);
          }

          const fixedContent = m3u8Content
            .split("\n")
            .map((line) => {
              const trimmedLine = line.trim();
              if (!trimmedLine || trimmedLine.startsWith("#")) return line;
              if (trimmedLine.includes(".m3u8") || trimmedLine.includes(".ts")) {
                const segmentUrl = trimmedLine.match(/^https?:\/\//) ? trimmedLine : baseUrl + trimmedLine;
                const endpoint = trimmedLine.includes(".ts") ? "ts" : "m3u8";
                const proxySegmentUrl = `http://localhost:${serverPort}/${endpoint}?url=${encodeURIComponent(segmentUrl)}`;
                log(`[m3u8] Generated segment URL: ${proxySegmentUrl}`);
                return proxySegmentUrl;
              }
              return line;
            })
            .join("\n");

          res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
          res.end(fixedContent);
        } catch (error) {
          log(`[m3u8] ไม่สามารถประมวลผล m3u8: ${error.message}`, "error");
          sendError(502, `ไม่สามารถดึง .m3u8 จาก ${channelUrl}: ${error.message}`, true);
        }
      } else if (req.url.startsWith("/ts?")) {
        const params = new URLSearchParams(req.url.slice(4));
        const tsUrl = params.get("url");
        if (!tsUrl) return sendError(400, "ไม่มีพารามิเตอร์ url", true);

        const channels = channelsCache.data || [];
        const channel = channels.find(ch => ch.file === tsUrl) || {};

        log(`[ts] เริ่มดึง .ts: ${tsUrl}`);
        try {
          await fetchContent(tsUrl, true, channel, 5, tsUrl.includes("dookeela.live") ? tsUrl : channel.file || "https://dookeela.live/live-tv/altv4");
        } catch (error) {
          log(`[ts] ไม่สามารถดึง .ts: ${error.message}`, "error");
          sendError(502, `ไม่สามารถดึง .ts จาก ${tsUrl}: ${error.message}`, true);
        }
      } else {
        sendError(404, "Not Found");
      }
    } catch (error) {
      log(`[server] ข้อผิดพลาดในเซิร์ฟเวอร์: ${error.message}`, "error");
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("ข้อผิดพลาดภายในเซิร์ฟเวอร์");
      } else {
        res.end();
      }
    }
  });

  server.on("clientError", (err, socket) => {
    log(`[server] Client error: ${err.message}`, "error");
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  const tryListen = () => {
    return new Promise((resolve, reject) => {
      server
        .listen(currentPort, () => {
          serverPort = currentPort;
          isProxyRunning = true;
          log(`[server] Proxy server started on port ${serverPort}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("proxy-started", serverPort);
          }
          resolve(serverPort);
        })
        .on("error", (err) => {
          if (err.code === "EADDRINUSE" && currentPort < MAX_PORT) {
            currentPort++;
            log(`[server] Port ${currentPort - 1} in use, trying ${currentPort}`, "warn");
            tryListen().then(resolve).catch(reject);
          } else {
            log(`[server] Failed to start server: ${err.message}`, "error");
            reject(err);
          }
        });
    });
  };

  proxyServerInstance = {
    server,
    start: async (channelUrl) => {
      if (isProxyRunning && currentChannelUrl !== channelUrl) {
        proxyServerInstance.stop();
      }
      if (!isProxyRunning) {
        serverPort = await tryListen();
        currentChannelUrl = channelUrl;
        log(`[proxy] Started proxy server on port ${serverPort} for ${channelUrl}`);
        return serverPort;
      }
      currentChannelUrl = channelUrl;
      log(`[proxy] Proxy already running, updated to channel: ${channelUrl}`);
      return serverPort;
    },
    stop: () => {
      if (isProxyRunning) {
        server.close(() => {
          isProxyRunning = false;
          currentChannelUrl = null;
          log("[proxy] Proxy server stopped");
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("proxy-stopped");
          }
        });
      }
    },
    isRunning: () => isProxyRunning,
    getPort: () => serverPort,
    fetchM3u8: async (channelUrl) => {
      if (!isProxyRunning || !serverPort) {
        throw new Error("Local proxy server is not running");
      }
      const proxyUrl = `http://localhost:${serverPort}/m3u8?url=${encodeURIComponent(channelUrl)}`;
      const response = await axiosInstance.get(proxyUrl, { timeout: 15000 });
      return response.data;
    },
  };

  return proxyServerInstance;
}
ipcMain.on("start-proxy", async (event, channelUrl) => {
  if (!proxyServerInstance) {
    proxyServerInstance = createServer(mainWindow);
  }
  try {
    const port = await proxyServerInstance.start(channelUrl);
    log(`[IPC] Proxy started for channel: ${channelUrl} on port ${port}`);
    event.reply("proxy-started", port);
  } catch (error) {
    log(`[IPC] Failed to start proxy: ${error.message}`, "error");
    event.reply("proxy-error", error.message);
  }
});

ipcMain.on("stop-proxy-for-channel", (event) => {
  if (proxyServerInstance && proxyServerInstance.isRunning()) {
    proxyServerInstance.stop();
    log("[IPC] Proxy stopped for previous channel");
    event.reply("proxy-stopped");
  }
});

let progressWindow = null;

function createProgressWindow() {
  progressWindow = new BrowserWindow({
    width: 400,
    height: 150,
    title:
      currentLanguage === "th" ? "กำลังดาวน์โหลดอัปเดต" : "Downloading Update",
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    resizable: false,
    alwaysOnTop: true,
    frame: false,
    backgroundColor: "#1e1e1e",
  });

  progressWindow.loadFile(path.join(__dirname, "progress.html"));

  progressWindow.on("closed", () => {
    progressWindow = null;
  });

  return progressWindow;
}

function compareVersions(v1, v2) {
  const v1parts = v1.split(".").map(Number);
  const v2parts = v2.split(".").map(Number);
  for (let i = 0; i < v1parts.length; i++) {
    if (v2parts.length === i) return 1;
    if (v1parts[i] === v2parts[i]) continue;
    return v1parts[i] > v2parts[i] ? 1 : -1;
  }
  return v2parts.length > v1parts.length ? -1 : 0;
}

function checkForUpdatesAuto() {
  log("checkForUpdatesAuto started");
  if (!mainWindow || mainWindow.isDestroyed()) {
    log("Main window is not available for auto update check", "warn");
    return;
  }

  axiosInstance
    .get(UPDATE_CHECK_URL, { timeout: 5000 })
    .then((response) => {
      log("Auto update fetch successful: " + JSON.stringify(response.data));

      const latestVersion = response.data.version;
      const notes = response.data.notes || "";
      const arch = os.arch();
      let downloadUrl;

      if (response.data.files) {
        if (arch === "ia32" && response.data.files.x86) {
          downloadUrl = response.data.files.x86.downloadUrl;
        } else if (arch === "x64" && response.data.files.x64) {
          downloadUrl = response.data.files.x64.downloadUrl;
        }
      }

      if (!downloadUrl) {
        log(
          "No suitable update file found for your system architecture during auto check",
          "warn",
        );
        return;
      }

      if (compareVersions(latestVersion, CURRENT_VERSION) > 0) {
        log(
          `New version found: ${latestVersion} (current: ${CURRENT_VERSION})`,
        );
        dialog
          .showMessageBox(mainWindow, {
            type: "info",
            title:
              currentLanguage === "th" ? "มีการอัปเดตใหม่" : "Update Available",
            message:
              currentLanguage === "th"
                ? `มีเวอร์ชันใหม่ (${latestVersion}) พร้อมใช้งาน\nบันทึกการเปลี่ยนแปลง: ${notes}\nต้องการดาวน์โหลดหรือไม่?`
                : `A new version (${latestVersion}) is available.\nRelease Notes: ${notes}\nWould you like to download it?`,
            buttons: [
              currentLanguage === "th" ? "ดาวน์โหลด" : "Download",
              currentLanguage === "th" ? "ภายหลัง" : "Later",
            ],
          })
          .then((result) => {
            if (result.response === 0) {
              downloadUpdate(downloadUrl, latestVersion);
              log(`User chose to download update for version ${latestVersion}`);
            } else {
              log("User postponed update");
            }
          });
      } else {
        log(
          `No update available. Current version (${CURRENT_VERSION}) is latest`,
        );
      }
    })
    .catch((error) => {
      log(
        "Could not check for updates automatically: " + error.message,
        "error",
      );
    });
}

async function downloadUpdate(downloadUrl, latestVersion) {
  const arch = os.arch();
  const archSuffix = arch === "x64" ? "-x64" : "-ia32";
  const downloadPath = path.join(
    app.getPath("downloads"),
    `IPTV-Player-v${latestVersion}${archSuffix}.exe`,
  );
  log(`Starting download of update from ${downloadUrl} to ${downloadPath}`);

  const progressWin = createProgressWindow();

  await new Promise((resolve, reject) => {
    progressWin.webContents.on("did-finish-load", () => {
      log("progress.html loaded successfully in progressWindow");
      resolve();
    });
    progressWin.webContents.on("did-fail-load", (event, errorCode, errorDescription) => {
      const errorMsg = `Failed to load progress.html: ${errorDescription} (Code: ${errorCode})`;
      log(errorMsg, "error");
      showError(errorMsg);
      reject(new Error(errorMsg));
    });
  });

  try {
    const response = await axiosInstance({
      method: "get",
      url: downloadUrl,
      responseType: "stream",
      timeout: 35000,
      onDownloadProgress: (progressEvent) => {
        const { loaded, total } = progressEvent;
        const percentage = total ? Math.round((loaded * 100) / total) : 0;
        if (progressWin && !progressWin.isDestroyed()) {
          progressWin.webContents.send("download-progress", {
            percentage,
            loaded: (loaded / 1024 / 1024).toFixed(2),
            total: total ? (total / 1024 / 1024).toFixed(2) : "unknown",
          });
        }
        log(
          `Download progress: ${percentage}% (${loaded} / ${total || "unknown"} bytes)`,
        );
      },
    });

    const writer = fs.createWriteStream(downloadPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on("finish", () => {
        log(`Update downloaded successfully to ${downloadPath}`);
        if (progressWin && !progressWin.isDestroyed()) {
          progressWin.close();
        }
        dialog
          .showMessageBox(mainWindow, {
            type: "info",
            title:
              currentLanguage === "th"
                ? "ดาวน์โหลดสำเร็จ"
                : "Download Complete",
            message:
              currentLanguage === "th"
                ? `ดาวน์โหลดเวอร์ชัน ${latestVersion} เสร็จสิ้น\nไฟล์อยู่ที่: ${downloadPath}\nต้องการเปิดโฟลเดอร์หรือไม่?`
                : `Version ${latestVersion} downloaded successfully.\nFile saved to: ${downloadPath}\nWould you like to open the folder?`,
            buttons: [
              currentLanguage === "th" ? "เปิดโฟลเดอร์" : "Open Folder",
              currentLanguage === "th" ? "ปิด" : "Close",
            ],
          })
          .then((result) => {
            if (result.response === 0) {
              shell.showItemInFolder(downloadPath);
            }
            resolve();
          });
      });
      writer.on("error", (error) => {
        log(`Download error: ${error.message}`, "error");
        if (progressWin && !progressWin.isDestroyed()) {
          progressWin.webContents.send("download-error", error.message);
        }
        showError(`Failed to download update: ${error.message}`);
        reject(error);
      });
    });
  } catch (error) {
    log(`Download request failed: ${error.message}`, "error");
    if (progressWin && !progressWin.isDestroyed()) {
      progressWin.webContents.send("download-error", error.message);
    }
    showError(`Cannot start download: ${error.message}`);
    throw error;
  }
}

function checkForUpdatesManual() {
  log("checkForUpdatesManual started");
  if (!mainWindow || mainWindow.isDestroyed()) {
    showError("Main window is not available");
    return;
  }

  axiosInstance
    .get(UPDATE_CHECK_URL, { timeout: 7000 })
    .then((response) => {
      log("Manual update fetch successful: " + JSON.stringify(response.data));

      const latestVersion = response.data.version;
      const notes = response.data.notes || "";
      const arch = os.arch();
      let downloadUrl;

      if (response.data.files) {
        if (arch === "ia32" && response.data.files.x86) {
          downloadUrl = response.data.files.x86.downloadUrl;
        } else if (arch === "x64" && response.data.files.x64) {
          downloadUrl = response.data.files.x64.downloadUrl;
        }
      }

      if (!downloadUrl) {
        showError(
          "No suitable update file found for your system architecture.",
        );
        return;
      }

      if (compareVersions(latestVersion, CURRENT_VERSION) > 0) {
        dialog
          .showMessageBox(mainWindow, {
            type: "info",
            title:
              currentLanguage === "th" ? "มีการอัปเดตใหม่" : "Update Available",
            message:
              currentLanguage === "th"
                ? `มีเวอร์ชันใหม่ (${latestVersion}) พร้อมใช้งาน\nบันทึกการเปลี่ยนแปลง: ${notes}\nต้องการดาวน์โหลดหรือไม่?`
                : `A new version (${latestVersion}) is available.\nRelease Notes: ${notes}\nWould you like to download it?`,
            buttons: [
              currentLanguage === "th" ? "ดาวน์โหลด" : "Download",
              currentLanguage === "th" ? "ยกเลิก" : "Cancel",
            ],
          })
          .then((result) => {
            if (result.response === 0) {
              downloadUpdate(downloadUrl, latestVersion);
              log(
                `User manually chose to download update for version ${latestVersion}`,
              );
            }
          });
      } else {
        dialog.showMessageBox(mainWindow, {
          type: "info",
          title:
            currentLanguage === "th" ? "ไม่มีอัปเดต" : "No Update Available",
          message:
            currentLanguage === "th"
              ? `คุณใช้เวอร์ชันล่าสุดอยู่แล้ว (${CURRENT_VERSION})`
              : `You are already using the latest version (${CURRENT_VERSION})`,
          buttons: [currentLanguage === "th" ? "ตกลง" : "OK"],
        });
      }
    })
    .catch((error) => {
      showError("Could not check for updates: " + error.message);
      log("Manual update check failed: " + error.message, "error");
    });
}

function createAboutWindow() {
  if (aboutWindow) {
    aboutWindow.focus();
    return;
  }

  aboutWindow = new BrowserWindow({
    width: 600,
    height: 700,
    title: "เกี่ยวกับ IPTV Player",
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    resizable: false,
    alwaysOnTop: true,
    backgroundColor: "#1e1e1e",
  });

  aboutWindow.loadFile(path.join(__dirname, "about.html"));
  aboutWindow.setMenu(null);

  aboutWindow.on("closed", () => {
    aboutWindow = null;
  });
}

ipcMain.handle("get-app-version", async () => {
  return app.getVersion();
});

function createMenuTemplate(lang) {
  const translations = {
    th: {
      file: "ไฟล์",
      openFile: "เปิดไฟล์",
      openStream: "เปิดสตรีม",
      importFile: "นำเข้าจากไฟล์",
      importUrl: "นำเข้าจาก URL",
      exportJs: "ส่งออกเป็นไฟล์ .js",
      exportM3U: "ส่งออกเป็นไฟล์ .m3u",
      exportFavorites: "ส่งออกช่องโปรด",
      importFavorites: "นำเข้าช่องโปรด",
      language: "ภาษา",
      thai: "ภาษาไทย",
      english: "English",
      help: "ช่วยเหลือ",
      about: "เกี่ยวกับ",
      checkUpdate: "ตรวจสอบการอัปเดต",
      aboutTitle: "เกี่ยวกับ IPTV Player",
      aboutMessage:
        "IPTV Player v" +
        CURRENT_VERSION +
        "\nพัฒนาโดย Son Tong\nห้ามนำไปจำหน่าย",
      ok: "ตกลง",
      select: "เลือก",
      remove: "ลบ",
      noImportedFiles: "ไม่มีไฟล์ที่นำเข้า",
      view: "มุมมอง",
      alwaysOnTop: "อยู่ด้านบนตลอดเวลา",
    },
    en: {
      file: "File",
      openFile: "Open File",
      openStream: "Open Stream",
      importFile: "Import from File",
      importUrl: "Import from URL",
      exportJs: "Export as .js File",
      exportM3U: "Export as .m3u File",
      exportFavorites: "Export Favorites",
      importFavorites: "Import Favorites",
      language: "Language",
      thai: "Thai",
      english: "English",
      help: "Help",
      about: "About",
      checkUpdate: "Check for Updates",
      aboutTitle: "About IPTV Player",
      aboutMessage:
        "IPTV Player v" +
        CURRENT_VERSION +
        "\nDeveloped by Son Tong\nDo not distribute",
      ok: "OK",
      select: "Select",
      remove: "Remove",
      noImportedFiles: "No imported files",
      view: "View",
      alwaysOnTop: "Always on Top",
    },
  };

  const t = translations[lang] || translations["en"];
  const importedFiles = getImportedFiles();
  const importedFilesSubmenu =
    importedFiles.length > 0
      ? importedFiles.map((file) => ({
          label: file.name,
          submenu: [
            {
              label: t.select,
              click: () =>
                ipcMain.emit("select-imported-file", null, file.path),
            },
            {
              label: t.remove,
              click: () =>
                ipcMain.emit("remove-imported-file", null, file.path),
            },
          ],
        }))
      : [{ label: t.noImportedFiles, enabled: false }];

  const menuTemplate = [
    {
      label: t.file,
      submenu: [
        { label: t.openFile, click: openFileDialog },
        {
          label: t.openStream,
          click: () => {
            log("เมนูเปิดสตรีมถูกคลิก");
            openStreamDialog();
          },
        },
        {
          label: currentLanguage === "th" ? "เปิดโฟลเดอร์" : "Open Folder",
          click: () => {
            log("เมนูเปิดโฟลเดอร์ถูกคลิก");
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("trigger-open-folder");
              log("ส่งคำสั่ง trigger-open-folder ไปยัง Renderer");
            } else {
              log("หน้าต่างหลักไม่พร้อมใช้งาน", "warn");
              showError("หน้าต่างหลักไม่พร้อมใช้งาน");
            }
          },
        },
        { label: t.importFile, click: importChannelsFromFile },
        { label: t.importUrl, click: importChannelsFromUrl },
        {
          label: t.exportJs,
          click: async () => {
            const channels = await loadChannelsFile();
            await exportChannelsAsJs(channels);
          },
        },
        {
          label: t.exportM3U,
          click: async () => {
            const channels = await loadChannelsFile();
            console.log("Channels before export:", channels);
            await exportChannelsAsM3U(channels);
          },
        },
        { label: t.exportFavorites, click: exportFavorites },
        { label: t.importFavorites, click: importFavorites },
      ],
    },
    {
      label: t.view,
      submenu: [
        {
          label: t.alwaysOnTop,
          type: "checkbox",
          checked: mainWindow ? mainWindow.isAlwaysOnTop() : false,
          click: () => {
            const isAlwaysOnTop = mainWindow.isAlwaysOnTop();
            mainWindow.setAlwaysOnTop(!isAlwaysOnTop);
            log(`ตั้งค่าอยู่ด้านบนตลอดเวลาเป็น: ${!isAlwaysOnTop}`);
            mainWindow.webContents.send(
              "always-on-top-updated",
              !isAlwaysOnTop,
            );
          },
        },
      ],
    },
    {
      label: t.language,
      submenu: [
        {
          label: t.thai,
          type: "radio",
          checked: lang === "th",
          click: () => setLanguage("th"),
        },
        {
          label: t.english,
          type: "radio",
          checked: lang === "en",
          click: () => setLanguage("en"),
        },
      ],
    },
    {
      label: t.help,
      submenu: [
        { label: t.checkUpdate, click: checkForUpdatesManual },
        { label: t.about, click: () => createAboutWindow() },
      ],
    },
  ];
  return menuTemplate;
}

async function openFileDialog() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showError("Main window is not available");
    return;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      {
        name: "Media Files",
        extensions: ["mp4", "mkv", "avi", "mov", "flv", "m3u8", "mpd"],
      },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (!result.canceled) {
    const filePath = result.filePaths[0];
    const media = {
      name: path.basename(filePath),
      file: filePath,
      group: "Local Media",
      logo: "assets/tv-app.png",
    };
    log(`Selected local file: ${filePath}`);
    mainWindow.webContents.send("media-selected", media);
  }
}

async function openStreamDialog() {
  log("openStreamDialog called");
  if (!mainWindow || mainWindow.isDestroyed()) {
    log("Main window is not available or destroyed", "error");
    showError("Main window is not available");
    return;
  }

  try {
    log("Sending show-stream-prompt event to renderer");
    mainWindow.webContents.send("show-stream-prompt");
  } catch (error) {
    log(`Error in openStreamDialog: ${error.message}`, "error");
    showError(`Failed to open stream dialog: ${error.message}`);
  }
}

async function exportFavorites() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log("Main window not available", "error");
    return;
  }
  const favorites = store.get("favorites", []);
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: "favorites.json",
    filters: [{ name: "JSON Files", extensions: ["json"] }],
  });

  if (!result.canceled) {
    if (!Array.isArray(favorites) || favorites.length === 0) {
      log("No favorites data to export", "warn");
      showError("No favorites available to export");
      return;
    }
    fs.writeFileSync(result.filePath, JSON.stringify(favorites, null, 2));
    log(`Favorites exported to ${result.filePath} with ${favorites.length} items`);
  }
}

async function importFavorites() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log("Main window not available", "error");
    return;
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "JSON Files", extensions: ["json"] }],
  });

  if (!result.canceled) {
    const filePath = result.filePaths[0];
    try {
      const favoritesData = fs.readFileSync(filePath, "utf-8");
      const importedFavorites = JSON.parse(favoritesData);
      if (!Array.isArray(importedFavorites))
        throw new Error("Invalid favorites format");
      store.set("favorites", importedFavorites);
      log(
        `Favorites imported from ${filePath}: ${importedFavorites.length} items`,
      );
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("favorites-updated", importedFavorites);
      }
    } catch (error) {
      log(`Failed to import favorites: ${error.message}`, "error");
      showError(`Failed to import favorites: ${error.message}`);
    }
  }
}

async function exportChannelsAsJs(channels) {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: "channels.js",
    filters: [{ name: "JavaScript Files", extensions: ["js"] }],
  });

  if (!result.canceled) {
    fs.writeFileSync(
      result.filePath,
      `module.exports = ${JSON.stringify(channels, null, 2)};`,
    );
    log(`Channels exported as JS to ${result.filePath}`);
  }
}

async function exportChannelsAsM3U(channels) {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: "channels.m3u",
    filters: [{ name: "M3U Files", extensions: ["m3u"] }],
  });

  if (!result.canceled) {
    let m3uContent = "#EXTM3U\n";
    channels.forEach((channel) => {
      // เพิ่มข้อมูลพื้นฐาน
      m3uContent += `#EXTINF:-1 tvg-name="${channel.name}" tvg-logo="${channel.logo}" group-title="${channel.group}",${channel.name}\n`;

      // เพิ่มข้อมูล HTTP Options (ถ้ามี)
      if (channel.httpOptions) {
        if (channel.httpOptions.userAgent) {
          m3uContent += `#EXTVLCOPT:http-user-agent=${channel.httpOptions.userAgent}\n`;
        }
        if (channel.httpOptions.referrer) {
          m3uContent += `#EXTVLCOPT:http-referrer=${channel.httpOptions.referrer}\n`;
        }
      }

      // เพิ่มข้อมูล DRM (ถ้ามี)
      if (channel.drm && channel.drm.clearkey) {
        const { keyId, key } = channel.drm.clearkey;
        if (keyId && key) {
          m3uContent += `#KODIPROP:inputstream.adaptive.license_type=clearkey\n`;
          m3uContent += `#KODIPROP:inputstream.adaptive.license_key=${keyId}:${key}\n`;
        }
      }

      // เพิ่ม URL ของช่อง
      m3uContent += `${channel.file}\n`;
    });
    fs.writeFileSync(result.filePath, m3uContent);
    log(`Channels exported as M3U to ${result.filePath} with DRM info`);
  }
}
async function importChannelsFromFile() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showError("หน้าต่างหลักไม่พร้อมใช้งาน");
    return null;
  }

  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "ไฟล์ที่รองรับ", extensions: ["js", "m3u", "w3u", "json"] },
      { name: "ไฟล์ทั้งหมด", extensions: ["*"] },
    ],
  });

  if (!result.canceled) {
    const filePath = result.filePaths[0];
    const fileType = path.extname(filePath).toLowerCase().replace(".", "");
    const allowedTypes = ["js", "m3u", "w3u", "json"];

    try {
      if (!allowedTypes.includes(fileType)) {
        throw new Error(`ประเภทไฟล์ .${fileType} ไม่รองรับ`);
      }

      const fileContent = fs.readFileSync(filePath, "utf-8").trim();
      let importedChannels = [];

      switch (fileType) {
        case "js":
          if (
            !fileContent.includes("module.exports") &&
            !fileContent.match(/^\s*(let|var|const)\s+.*?\s*=\s*\[/)
          ) {
            throw new Error("เนื้อหาไฟล์ .js ไม่ตรงกับรูปแบบที่คาดหวัง");
          }
          importedChannels = require(filePath);
          break;

        case "m3u":
          if (!fileContent.match(/^#EXTINF:/m)) {
            throw new Error(
              "เนื้อหาไฟล์ .m3u ไม่มีข้อมูลช่อง (#EXTINF:) ที่ถูกต้อง",
            );
          }
          importedChannels = parseM3U(fileContent);
          break;

        case "w3u":
          if (
            !fileContent.includes('"groups"') &&
            !fileContent.includes('"stations"') &&
            !fileContent.trim().startsWith("[")
          ) {
            throw new Error("เนื้อหาไฟล์ .w3u ไม่มีโครงสร้าง JSON ที่ถูกต้อง");
          }
          importedChannels = parseW3U(fileContent);
          break;

        case "json":
          if (
            !fileContent.trim().startsWith("[") &&
            !fileContent.trim().startsWith("{")
          ) {
            throw new Error(
              "เนื้อหาไฟล์ .json ไม่มีโครงสร้างอาร์เรย์หรือออบเจกต์ที่ถูกต้อง",
            );
          }
          importedChannels = JSON.parse(fileContent);
          break;
      }

      if (!Array.isArray(importedChannels)) {
        throw new Error(`ไฟล์ .${fileType} ไม่มีข้อมูลช่องในรูปแบบอาร์เรย์`);
      }

importedChannels = importedChannels.map((channel) => ({
  name: channel.name || "ช่องไม่ระบุชื่อ",
  file: channel.file || "",
  group: channel.group || "กลุ่มทั่วไป",
  logo: channel.logo || "assets/tv-app.png",
  httpOptions: channel.httpOptions || {},
  drm: channel.drm || {}, // คงข้อมูล drm ไว้
  ...channel // วางท้ายเพื่อให้ properties อื่น ๆ ไม่ถูกทับ
}));

      const invalidChannels = importedChannels.filter(
        (ch) => !ch.file || !ch.name,
      );
      if (invalidChannels.length > 0) {
        throw new Error(
          `พบ ${invalidChannels.length} ช่องที่ไม่มีชื่อหรือลิงก์`,
        );
      }

      ensureChannelsFileExists();
      const release = await lock(channelsFilePath);
      try {
        fs.writeFileSync(
          channelsFilePath,
          `module.exports = ${JSON.stringify(importedChannels, null, 2)};`,
        );
      } finally {
        await release();
      }

      delete require.cache[require.resolve(channelsFilePath)];
      channelsCache = {
        data: importedChannels,
        timestamp: Date.now(),
        maxSize: channelsCache.maxSize,
      };

      addImportedFile(filePath, fileType);
      store.set("lastChannelsPath", filePath);

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("channels-updated", importedChannels);
        log(
          `นำเข้าช่องสำเร็จ ${importedChannels.length} ช่อง จากไฟล์ .${fileType}`,
        );
      }

      return importedChannels;
    } catch (error) {
      log(`การนำเข้าล้มเหลว: ${error.message}`, "error");

      dialog.showMessageBox(mainWindow, {
        type: "error",
        title: "ไม่สามารถนำเข้าไฟล์",
        message:
          `ไฟล์ .${fileType} ไม่ตรงกับรูปแบบที่กำหนด:\n\n${error.message}\n\n` +
          "โปรดตรวจสอบว่าไฟล์มีรูปแบบที่ถูกต้องตามนามสกุล",
        buttons: ["ตกลง"],
      });

      return loadChannelsFile();
    }
  }
  return loadChannelsFile();
}


async function uploadChannelImage(channel, index, imgElement) {
    try {
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.style.display = "none";

        fileInput.onchange = async () => {
            const file = fileInput.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async (e) => {
                const base64Data = e.target.result;
                const fileName = `channel_${Date.now()}_${file.name}`;
                
                // บันทึกไฟล์ลงดิสก์และรับ path
                const savedImagePath = await window.electronAPI.saveImageFile(base64Data, fileName);
                channel.logo = savedImagePath; // ใช้ path แทน Data URL
                imgElement.src = savedImagePath;

                updateChannel(channel, index);
                console.log(`Updated logo for channel "${channel.name}" to ${savedImagePath}`);
            };
            reader.readAsDataURL(file);
        };

        document.body.appendChild(fileInput);
        fileInput.click();
        document.body.removeChild(fileInput);
    } catch (error) {
        console.error("Failed to upload image:", error);
        alert(currentLanguage === 'th' ? "ไม่สามารถอัปโหลดรูปภาพได้" : "Failed to upload image");
    }
}

async function importChannelsFromUrl() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showError("Main window is not available");
    return null;
  }

  try {
    mainWindow.webContents.send("show-import-url-popup");

    const url = await new Promise((resolve) => {
      ipcMain.once("import-url-response", (event, inputUrl) =>
        resolve(inputUrl),
      );
    });

    if (!url) {
      log("User cancelled URL import");
      return null;
    }

    log(`Attempting to fetch channels from URL: ${url}`);

    const isRawFileUrl = /\.(js|m3u|w3u|json)$/i.test(url);
    let finalContent;
    let finalUrl = url;
    let fileType;

    const response = await axiosInstance.get(url, {
      responseType: "text",
    });

    if (response.status !== 200) {
      throw new Error(`Failed to fetch URL: HTTP ${response.status}`);
    }

    finalContent = response.data.trim();

    let importedChannels = [];

    const defaultLogos = {
      mp4: "mp4.png",
      mkv: "mkv.png",
      avi: "avi.png",
      mov: "mov.png",
      flv: "flv.png",
      m3u8: "m3u8.png",
      mpd: "mpd.png",
      webm: "webm.png",
      ts: "ts.png",
      aac: "aac.png",
      ogg: "ogg.png",
      wav: "wav.png",
      mp3: "mp3.png",
    };

    if (
      finalContent.includes("<table") ||
      finalContent.includes("Index of") ||
      finalContent.includes("Parent Directory")
    ) {
      log(`Detected directory listing at: ${url}`);

      const videoExtensions =
        /\.(mp4|mkv|avi|mov|flv|m3u8|mpd|webm|ts|aac|ogg|wav|mp3)$/i;
      const imageExtensions = /\.(jpg|jpeg|png|gif)$/i;
      const fileLinks = {};
      const linkRegex = /<a href=["']?([^"'\s>]+)["']?.*?>([^<]+)<\/a>/gi;
      let match;

      while ((match = linkRegex.exec(finalContent)) !== null) {
        const href = match[1];
        const name = match[2].trim();
        if (href === "Parent Directory") continue;

        const fullUrl = href.startsWith("http")
          ? href
          : new URL(href, url).href;
        if (videoExtensions.test(href)) {
          const baseName = name.replace(videoExtensions, "");
          fileLinks[baseName] = fileLinks[baseName] || {};
          fileLinks[baseName].video = fullUrl;
        } else if (imageExtensions.test(href)) {
          const baseName = name.replace(imageExtensions, "");
          fileLinks[baseName] = fileLinks[baseName] || {};
          fileLinks[baseName].image = fullUrl;
        }
      }

      if (
        Object.keys(fileLinks).length === 0 ||
        !Object.values(fileLinks).some((f) => f.video)
      ) {
        throw new Error("No video files found in the directory listing");
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const groupName = `Imported Videos ${timestamp}`;

      importedChannels = Object.entries(fileLinks)
        .filter(([_, file]) => file.video)
        .map(([baseName, file]) => {
          const extensionMatch = file.video.match(videoExtensions);
          const extension = extensionMatch
            ? extensionMatch[0].slice(1).toLowerCase()
            : "mp4";
          const defaultLogo = defaultLogos[extension]
            ? path.join(__dirname, "assets", defaultLogos[extension])
            : path.join(__dirname, "assets", "assets/tv-app.png");
          return {
            name: baseName.replace(/_/g, " ").trim(),
            file: file.video,
            group: groupName,
            logo: file.image || defaultLogo,
            httpOptions: {
              userAgent:
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
              referrer: url,
            },
          };
        });

      fileType = "js";
      finalContent = `module.exports = ${JSON.stringify(importedChannels, null, 2)};`;
      log(
        `Found ${importedChannels.length} video files in directory listing, assigned to group: ${groupName}`,
      );
    } else if (
      isRawFileUrl ||
      finalContent.match(/^\s*(let|var|const|module\.exports|#EXTM3U|\[|{)/)
    ) {
      log(`Detected raw file or structured content at: ${url}`);
      fileType = isRawFileUrl ? url.split(".").pop().toLowerCase() : "txt";

      if (
        fileType === "js" ||
        finalContent.startsWith("module.exports") ||
        finalContent.match(/^\s*(let|var|const)/)
      ) {
        fileType = "js";
        importedChannels = eval(`(${finalContent})`);
        if (!Array.isArray(importedChannels))
          throw new Error("Imported .js data is not a valid channel array");
      } else if (
        fileType === "m3u" ||
        finalContent.startsWith("#EXTM3U") ||
        finalContent.match(/^#EXTINF:/m)
      ) {
        fileType = "m3u";
        importedChannels = parseM3U(finalContent);
      } else if (
        fileType === "w3u" ||
        finalContent.includes('"groups"') ||
        finalContent.includes('"stations"')
      ) {
        fileType = "w3u";
        importedChannels = parseW3U(finalContent);
      } else if (
        fileType === "json" ||
        finalContent.trim().startsWith("[") ||
        finalContent.trim().startsWith("{")
      ) {
        fileType = "json";
        importedChannels = JSON.parse(finalContent);
        if (!Array.isArray(importedChannels))
          throw new Error("Imported .json data is not a valid channel array");
        importedChannels.forEach((channel) => {
          if (!channel.name || !channel.file) {
            throw new Error(
              "Invalid JSON channel format: missing name or file",
            );
          }
        });
      } else {
        throw new Error(
          "Content is not in a recognizable .js, .m3u, .w3u, or .json format",
        );
      }
      finalContent = `module.exports = ${JSON.stringify(importedChannels, null, 2)};`;
    } else {
      log(`Detected potential web page or redirect at: ${url}`);
      const offscreenWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          offscreen: true,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });

      await new Promise((resolve, reject) => {
        offscreenWindow.webContents.on("did-finish-load", async () => {
          try {
            const currentUrl = offscreenWindow.webContents.getURL();
            log(`Page loaded, current URL: ${currentUrl}`);

            const content = await offscreenWindow.webContents.executeJavaScript(
              "document.body.innerText",
            );
            finalContent = content.trim();

            if (
              finalContent.includes("<html") ||
              finalContent.includes("You are being redirected") ||
              finalContent.includes("Javascript is required")
            ) {
              log(
                "Detected redirect or HTML, searching for final data URL",
                "warn",
              );
              const htmlContent =
                await offscreenWindow.webContents.executeJavaScript(
                  "document.documentElement.outerHTML",
                );
              const urlMatch = htmlContent.match(
                /https?:\/\/[^\s"'<>]+(?:\.(?:json|js|m3u|w3u))?(?=["'\s<>])/i,
              );
              if (urlMatch) {
                finalUrl = urlMatch[0];
                log(`Found potential data URL: ${finalUrl}`);
                const response = await axiosInstance.get(finalUrl, {
                  responseType: "text",
                  headers: {
                    "User-Agent":
                      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
                    Accept: "text/plain,application/json,*/*",
                  },
                });
                finalContent = response.data.trim();
                fileType = finalUrl.split(".").pop().toLowerCase();
              } else {
                throw new Error("Unable to extract data from redirect page");
              }
            } else {
              finalUrl = currentUrl;
              fileType = finalUrl.split(".").pop().toLowerCase() || "txt";
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        offscreenWindow.webContents.on(
          "did-fail-load",
          (event, errorCode, errorDescription) => {
            reject(
              new Error(
                `Failed to load URL: ${errorDescription} (Code: ${errorCode})`,
              ),
            );
          },
        );

        offscreenWindow.loadURL(url);
      });

      offscreenWindow.close();

      if (
        fileType === "js" ||
        finalContent.startsWith("module.exports") ||
        finalContent.match(/^\s*(let|var|const)/)
      ) {
        fileType = "js";
        importedChannels = eval(`(${finalContent})`);
        if (!Array.isArray(importedChannels))
          throw new Error("Imported .js data is not a valid channel array");
      } else if (
        fileType === "m3u" ||
        finalContent.startsWith("#EXTM3U") ||
        finalContent.match(/^#EXTINF:/m)
      ) {
        fileType = "m3u";
        importedChannels = parseM3U(finalContent);
      } else if (
        fileType === "w3u" ||
        finalContent.includes('"groups"') ||
        finalContent.includes('"stations"')
      ) {
        fileType = "w3u";
        importedChannels = parseW3U(finalContent);
      } else if (fileType === "json") {
        fileType = "json";
        importedChannels = JSON.parse(finalContent);
        if (!Array.isArray(importedChannels))
          throw new Error("Imported .json data is not a valid channel array");
        importedChannels.forEach((channel) => {
          if (!channel.name || !channel.file) {
            throw new Error(
              "Invalid JSON channel format: missing name or file",
            );
          }
        });
      } else {
        throw new Error(
          "Content is not in a recognizable .js, .m3u, .w3u, or .json format",
        );
      }
      finalContent = `module.exports = ${JSON.stringify(importedChannels, null, 2)};`;
    }

    const fileName = `imported-from-url-${Date.now()}.js`;
    const filePath = path.join(userDataPath, fileName);
    fs.writeFileSync(filePath, finalContent);
    addImportedFile(filePath, "js");
    store.set("lastChannelsPath", filePath);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("channels-updated", importedChannels);
      log(
        `Sent channels-updated event with ${importedChannels.length} channels immediately`,
      );
      mainWindow.webContents.once("did-finish-load", () => {
        mainWindow.webContents.send("channels-updated", importedChannels);
        log(`Sent channels-updated event again after renderer loaded`);
      });
    }

    log(
      `Successfully imported channels from URL: ${url} to separate file: ${filePath}`,
    );
    const menuTemplate = createMenuTemplate(currentLanguage);
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
    return importedChannels;
  } catch (error) {
    showError(
      currentLanguage === "th"
        ? `ไม่สามารถนำเข้าจาก URL ได้: ${error.message}`
        : `Failed to import from URL: ${error.message}`,
    );
    log(`Import from URL failed: ${error.message}`, "error");
    return null;
  }
}

function parseM3U(content) {
  const lines = content.split("\n");
  const channels = [];
  let currentChannel = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("#EXTINF")) {
      // ปรับ regex เพื่อรองรับ tvg-id, tvg-logo, group-title ในลำดับใดก็ได้ และไม่มีช่องว่าง
      const match = trimmedLine.match(/#EXTINF:-?\d+(.*?),(.+)$/i);
      if (match) {
        const attributesStr = match[1] || "";
        const name = match[2].trim() || "ช่องไม่ระบุชื่อ";
        const groupMatch = attributesStr.match(/group-title="([^"]+)"/i);
        const logoMatch = attributesStr.match(/tvg-logo="([^"]+)"/i);
        const idMatch = attributesStr.match(/tvg-id="([^"]*)"/i); // รองรับ tvg-id (ถ้ามี)

        currentChannel = {
          name,
          group: groupMatch ? groupMatch[1] : "กลุ่มทั่วไป",
          logo: logoMatch ? logoMatch[1] : "assets/tv-app.png",
          file: "",
          httpOptions: {},
          drm: {} // เริ่มต้น drm object
        };

        // ถ้ามี tvg-id สามารถเพิ่มลงใน currentChannel ได้ถ้าต้องการ
        if (idMatch) {
          currentChannel.tvgId = idMatch[1]; // เก็บ tvg-id ถ้ามี (ไม่บังคับ)
        }
      }
    } else if (currentChannel && trimmedLine.startsWith("#KODIPROP:inputstream.adaptive.license_type=clearkey")) {
      currentChannel.drm.clearkey = currentChannel.drm.clearkey || {}; // สร้าง clearkey ถ้ายังไม่มี
    } else if (currentChannel && trimmedLine.startsWith("#KODIPROP:inputstream.adaptive.license_key")) {
      const keyMatch = trimmedLine.match(/license_key=([^:]+):(.+)/);
      if (keyMatch) {
        // สร้าง drm.clearkey ถ้ายังไม่มี เพื่อป้องกัน undefined
        currentChannel.drm.clearkey = currentChannel.drm.clearkey || {};
        currentChannel.drm.clearkey.keyId = keyMatch[1]; // ค่า keyId ดั้งเดิม
        currentChannel.drm.clearkey.key = keyMatch[2];   // ค่า key ดั้งเดิม
        log(`Parsed DRM for ${currentChannel.name}: keyId=${keyMatch[1]}, key=${keyMatch[2]}`);
      }
    } else if (currentChannel && trimmedLine.startsWith("#EXTVLCOPT:http-user-agent=")) {
      currentChannel.httpOptions.userAgent = trimmedLine.replace("#EXTVLCOPT:http-user-agent=", "");
    } else if (currentChannel && trimmedLine.startsWith("#EXTVLCOPT:http-referrer=")) {
      currentChannel.httpOptions.referrer = trimmedLine.replace("#EXTVLCOPT:http-referrer=", "");
    } else if (currentChannel && trimmedLine && !trimmedLine.startsWith("#")) {
      currentChannel.file = trimmedLine;
      log(`Adding channel ${currentChannel.name} with DRM: ${JSON.stringify(currentChannel.drm)}`);
      channels.push(currentChannel);
      currentChannel = null;
    }
  }

  log(`Parsed ${channels.length} channels from M3U content`);
  return channels;
}


function parseW3U(content) {
  try {
    const data = JSON.parse(content);
    let channels = [];

    // If the content is a flat array, handle it with the old logic
    if (Array.isArray(data)) {
      return data.map((station) => ({
        name: station.name || "Unknown",
        file: station.url || "",
        group: station.group || "General",
        logo: station.logo || "assets/tv-app.png",
        embed: station.embed || false,
        isHost: station.isHost || false,
      }));
    }

    // Handle the nested structure with "groups" and "stations"
    if (data.groups && Array.isArray(data.groups)) {
      data.groups.forEach((group) => {
        if (group.stations && Array.isArray(group.stations)) {
          const groupChannels = group.stations.map((station) => ({
            name: station.name || "Unknown",
            file: station.url || "",
            group: group.name || "General",
            logo: station.image || "assets/tv-app.png",
            embed: station.embed || false,  // Preserve embed flag
            isHost: station.isHost || false, // Preserve isHost flag
            httpOptions: station.httpOptions || {}, // Include httpOptions if present
            drm: station.drm || {}, // Include DRM if present
          }));
          channels = channels.concat(groupChannels);
        }
      });
    } else if (data.stations && Array.isArray(data.stations)) {
      // Fallback for simpler W3U format with just "stations"
      channels = data.stations.map((station) => ({
        name: station.name || "Unknown",
        file: station.url || "",
        group: "General",
        logo: station.image || "assets/tv-app.png",
        embed: station.embed || false,
        isHost: station.isHost || false,
        httpOptions: station.httpOptions || {},
        drm: station.drm || {},
      }));
    }

    if (channels.length === 0) {
      throw new Error("No valid stations found in W3U content");
    }

    log(`Parsed ${channels.length} channels from W3U content`);
    return channels;
  } catch (error) {
    log(`Failed to parse W3U content: ${error.message}`, "error");
    throw error;
  }
}

function setLanguage(lang) {
  currentLanguage = lang;
  store.set("currentLanguage", lang);
  log("Language set to: " + lang);
  const menuTemplate = createMenuTemplate(lang);
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  if (mainWindow) mainWindow.webContents.send("change-language", lang);
}

async function createWindow() {
  log("Creating main window");
  mainWindow = new BrowserWindow({
    width: 890,
    height: 640,
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: false,
      webgl: false,
      hardwareAcceleration: false,
    },
  });
  
  await ensureChannelsFileExists();
  await mainWindow.loadFile(path.join(__dirname, "index.html"));
  // mainWindow.webContents.openDevTools();
  
  proxyServerInstance = createServer(mainWindow); // สร้าง instance แต่ยังไม่เริ่ม

  let importedChannels = await loadChannelsFile();
  if (importedChannels.length > 0) {
    mainWindow.webContents.send("channels-updated", importedChannels);
  } else {
    const lastChannelsPath = store.get("lastChannelsPath");
    if (lastChannelsPath && fs.existsSync(lastChannelsPath)) {
      try {
        if (lastChannelsPath.endsWith(".js")) {
          importedChannels = require(lastChannelsPath);
        } else if (lastChannelsPath.endsWith(".m3u")) {
          importedChannels = parseM3U(
            fs.readFileSync(lastChannelsPath, "utf-8"),
          );
        } else if (lastChannelsPath.endsWith(".w3u")) {
          importedChannels = parseW3U(
            fs.readFileSync(lastChannelsPath, "utf-8"),
          );
        }
        if (importedChannels && importedChannels.length > 0) {
          const release = await lock(channelsFilePath);
          try {
            await fsPromises.writeFile(
              channelsFilePath,
              `module.exports = ${JSON.stringify(importedChannels, null, 2)};`,
            );
          } finally {
            await release();
          }
          channelsCache = {
            data: importedChannels,
            timestamp: Date.now(),
            maxSize: channelsCache.maxSize,
          };
          mainWindow.webContents.send("channels-updated", importedChannels);
          log(
            `Loaded and sent channels from last path: ${lastChannelsPath}`,
          );
        } else {
          mainWindow.webContents.send("channels-updated", []);
          log("Sent empty channels list as last path data was invalid");
        }
      } catch (error) {
        log("Error loading last channels: " + error.message, "error");
        mainWindow.webContents.send("channels-updated", []);
        log("Sent empty channels list due to error");
      }
    } else {
      mainWindow.webContents.send("channels-updated", []);
      log("Sent empty channels list on first run");
    }
  }

  const favorites = store.get("favorites", []);
  console.log(
    `Initial favorites from store: ${favorites.length} items`,
    favorites,
  );
  mainWindow.webContents.send("favorites-updated", favorites);
  log(`Sent initial favorites: ${favorites.length} items`);

  const menuTemplate = createMenuTemplate(currentLanguage);
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  log("Application menu set");

  mainWindow.webContents.on("context-menu", (event, params) => {
    const isEditable = params.isEditable || params.editFlags.canPaste;
    if (isEditable) {
      const menu = new Menu();
      menu.append(
        new MenuItem({
          label: currentLanguage === "th" ? "วาง" : "Paste",
          click: () => {
            mainWindow.webContents.send(
              "paste-from-clipboard",
              clipboard.readText(),
            );
          },
          enabled: clipboard.readText().length > 0,
        }),
      );
      menu.popup({ window: mainWindow, x: params.x, y: params.y });
    }
  });

  mainWindow.on("closed", () => {
    if (proxyServerInstance && proxyServerInstance.isRunning()) {
      proxyServerInstance.stop();
    }
    mainWindow = null;
  });
}



ipcMain.on("set-view-mode", (event, mode) => store.set("viewMode", mode));
ipcMain.handle("get-view-mode", () => store.get("viewMode", "grid"));

ipcMain.handle("get-favorites", async () => {
  const favorites = store.get("favorites", []);
  console.log(
    `get-favorites called, returning: ${favorites.length} items`,
    favorites,
  );
  return favorites;
});

ipcMain.on("set-favorites", (event, favorites) => {
  store.set("favorites", favorites);
  console.log(
    `Favorites saved to store: ${favorites.length} items`,
    favorites,
  );
  mainWindow.webContents.send("favorites-updated", favorites);
});

ipcMain.handle("open-file-dialog", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log("Main window not available", "error");
    return null;
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      {
        name: "Media Files",
        extensions: ["mp4", "mkv", "avi", "mov", "flv", "m3u8", "mpd"],
      },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (!result.canceled) {
    const filePath = result.filePaths[0];
    const media = {
      name: path.basename(filePath),
      file: filePath,
      group: "Local Media",
      logo: "assets/tv-app.png",
    };
    log(`File selected via IPC: ${filePath}`);
    return media;
  }
  return null;
});

ipcMain.on("open-stream-url", (event, url) => {
  const media = {
    name: "Stream " + new Date().toLocaleTimeString(),
    file: url.trim(),
    group: "Stream Media",
    logo: "assets/tv-app.png",
  };
  log(`Stream URL received from renderer: ${url}`);
  mainWindow.webContents.send("media-selected", media);
});

ipcMain.handle("get-m3u8", async (event, channel) => {
    const url = typeof channel === "string" ? channel : channel.file;
    if (!url) throw new Error("Channel URL is missing");

    if (url.toLowerCase().endsWith(".mpd")) {
        log(`[get-m3u8] Detected .mpd file: ${url}`);
        const drmInfo = channel.drm || {};
        return { url: url, drm: drmInfo };
    }

    if (!proxyServerInstance || !proxyServerInstance.isRunning()) {
        proxyServerInstance = createServer(mainWindow);
        const port = await proxyServerInstance.start(url);
        log(`[get-m3u8] Proxy started on port ${port} for ${url}`);
    }

    const proxyUrl = `http://localhost:${proxyServerInstance.getPort()}/m3u8?url=${encodeURIComponent(url)}`;
    log(`[get-m3u8] Returning proxy URL: ${proxyUrl}`);
    return proxyUrl;
});

ipcMain.on("log-message", (event, { message, level }) => {
  log(message, level); // ใช้ฟังก์ชัน log ที่มีอยู่ใน main.js
});

ipcMain.on("switch-to-lower-quality-stream", async (event, currentUrl) => {
  log(
    `Received request to switch to lower quality stream for: ${currentUrl}`,
  );
  try {
    const channels = await loadChannelsFile();
    const currentChannel = channels.find((ch) => ch.file === currentUrl);
    if (currentChannel && currentChannel.lowerQualityUrl) {
      const media = {
        name: currentChannel.name + " (Low Quality)",
        file: currentChannel.lowerQualityUrl,
        group: currentChannel.group,
              logo: currentChannel.logo,
      };
      log(`Switching to lower quality stream: ${currentChannel.lowerQualityUrl}`);
      mainWindow.webContents.send("media-selected", media);
    } else {
      log(`No lower quality stream available for: ${currentUrl}`, "warn");
      mainWindow.webContents.send("no-lower-quality-available");
    }
  } catch (error) {
    log(`Failed to switch to lower quality stream: ${error.message}`, "error");
    showError(`Failed to switch stream: ${error.message}`);
  }
});

ipcMain.on("select-imported-file", async (event, filePath) => {
  try {
    log(`Selecting imported file: ${filePath}`);
    store.set("lastChannelsPath", filePath);
    const fileType = path.extname(filePath).toLowerCase().replace(".", "");
    let importedChannels;

    if (fileType === "js") {
      delete require.cache[require.resolve(filePath)];
      importedChannels = require(filePath);
    } else if (fileType === "m3u") {
      const content = fs.readFileSync(filePath, "utf-8");
      importedChannels = parseM3U(content);
    } else if (fileType === "w3u") {
      const content = fs.readFileSync(filePath, "utf-8");
      importedChannels = parseW3U(content);
    } else if (fileType === "json") {
      const content = fs.readFileSync(filePath, "utf-8");
      importedChannels = JSON.parse(content);
    } else {
      throw new Error(`Unsupported file type: ${fileType}`);
    }

    if (!Array.isArray(importedChannels)) {
      throw new Error(`File ${filePath} does not contain a valid channel array`);
    }

    const release = await lock(channelsFilePath); // รอการล็อกไฟล์
    try {
      fs.writeFileSync(
        channelsFilePath,
        `module.exports = ${JSON.stringify(importedChannels, null, 2)};`,
      );
    } finally {
      await release(); // ปลดล็อกไฟล์ใน finally เพื่อให้แน่ใจว่าจะถูกปลดล็อกเสมอ
    }

    channelsCache = {
      data: importedChannels,
      timestamp: Date.now(),
      maxSize: channelsCache.maxSize,
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("channels-updated", importedChannels);
      log(`Switched to imported file: ${filePath} with ${importedChannels.length} channels`);
    }
  } catch (error) {
    log(`Failed to select imported file ${filePath}: ${error.message}`, "error");
    showError(`Failed to load file: ${error.message}`);
  }
});

ipcMain.on("remove-imported-file", (event, filePath) => {
  log(`Removing imported file: ${filePath}`);
  removeImportedFile(filePath);
  const menuTemplate = createMenuTemplate(currentLanguage);
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
});

ipcMain.handle("get-imported-files", () => {
  const files = getImportedFiles();
  log(`Returning ${files.length} imported files`);
  return files;
});

ipcMain.handle("get-system-info", async () => {
  const systemInfo = {
    platform: os.platform(),
    arch: os.arch(),
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    cpu: os.cpus()[0].model,
    version: app.getVersion(),
    userDataPath: app.getPath("userData"),
  };
  log("System info requested");
  return systemInfo;
});



ipcMain.handle("get-desktop-sources", async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
    });
    log(`Retrieved ${sources.length} desktop sources`);
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
    }));
  } catch (error) {
    log(`Failed to get desktop sources: ${error.message}`, "error");
    return [];
  }
});

ipcMain.handle("restart-app", async () => {
  log("Restart requested");
  if (proxyServerInstance && proxyServerInstance.isRunning()) {
    proxyServerInstance.stop();
  }
  app.relaunch();
  app.quit();
});

ipcMain.handle('capture-screenshot', async (event) => {
    try {
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
        console.log('Available sources:', sources.map(source => source.name));

        const source = sources.find(source => source.name === mainWindow.getTitle());
        if (!source) {
            throw new Error('Window source not found');
        }

        const screenshot = await desktopCapturer.getSources({
            types: ['window'],
            thumbnailSize: {
                width: mainWindow.getBounds().width,
                height: mainWindow.getBounds().height
            }
        });

        const windowSource = screenshot.find(s => s.name === mainWindow.getTitle());
        if (!windowSource) {
            throw new Error('Window source not capturable');
        }

        const image = windowSource.thumbnail;
        console.log('Original image size:', { width: image.getSize().width, height: image.getSize().height });

        return image.toDataURL();
    } catch (error) {
        console.error('Failed to capture screenshot:', error);
        throw error;
    }
});

ipcMain.handle('save-screenshot', async (event, data) => {
    try {
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'Save Screenshot',
            defaultPath: path.join(app.getPath('pictures'), 'screenshot.png'),
            filters: [{ name: 'Images', extensions: ['png'] }]
        });

        if (canceled || !filePath) {
            return false;
        }

        // ลบส่วน "data:image/png;base64," ออกจาก data URL
        const base64Data = data.replace(/^data:image\/png;base64,/, '');
        // ใช้ fsPromises.writeFile เพื่อเขียนไฟล์แบบ async
        await fsPromises.writeFile(filePath, base64Data, 'base64');
        console.log('Screenshot saved successfully at:', filePath);
        return true;
    } catch (error) {
        console.error('Failed to save screenshot:', error);
        throw error;
    }
});

ipcMain.handle("save-image-file", async (event, { base64Data, fileName }) => {
    try {
        const userDataPath = app.getPath("userData");
        const imageDir = path.join(userDataPath, "channel_images");
        const imagePath = path.join(imageDir, fileName);

        // สร้างโฟลเดอร์ถ้ายังไม่มี
        if (!fs.existsSync(imageDir)) {
            await fsPromises.mkdir(imageDir, { recursive: true });
            log(`Created directory: ${imageDir}`);
        }

        // ลบ "data:image/..." prefix ออกจาก base64 string
        const base64Image = base64Data.replace(/^data:image\/\w+;base64,/, "");
        await fsPromises.writeFile(imagePath, base64Image, "base64");
        log(`Image saved successfully at ${imagePath}`);

        return imagePath; // ส่ง path กลับไปยัง renderer
    } catch (error) {
        log(`Failed to save image: ${error.message}`, "error");
        throw error;
    }
});

let xtreamRefreshInterval = null;


ipcMain.handle("import-channels-from-api", async (event, { apiSource, url, username, password }) => {
  let importedChannels;

  try {
    if (apiSource !== "xtreme") {
      throw new Error("Only Xtream Codes is supported");
    }

    if (!url || !username || !password) {
      throw new Error("URL, Username, and Password are required for Xtream Codes");
    }

    const apiUrl = `${url}/get.php`;
    const fullUrl = `${apiUrl}?username=${username}&password=${password}&type=m3u_plus&output=m3u8`;
    log(`Calling Xtream Codes API: ${fullUrl}`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("import-start");
    }

    const response = await axiosInstance.get(apiUrl, {
      params: {
        username,
        password,
        type: "m3u_plus",
        output: "m3u8",
      },
      timeout: 10000,
    });
    const m3uContent = response.data;

    const allChannels = parseM3U(m3uContent);
    log(`Fetched M3U from Xtream Codes, total channels parsed: ${allChannels.length}`);

    importedChannels = [];
    const batchSize = 500;
    let filteredCount = 0;

    for (let i = 0; i < allChannels.length; i += batchSize) {
      const batch = allChannels.slice(i, i + batchSize);
      const validBatch = batch.filter((ch) => {
        const isValid = ch.file && ch.file.toLowerCase().endsWith(".m3u8");
        if (!isValid) filteredCount++;
        return isValid;
      });
      importedChannels = importedChannels.concat(validBatch);

      const processedCount = Math.min(i + batchSize, allChannels.length);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("import-progress", {
          total: allChannels.length,
          imported: processedCount,
        });
      }
      log(`Progress: Processed ${processedCount}/${allChannels.length} channels`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (importedChannels.length === 0) {
      throw new Error("No valid .m3u8 streams found from Xtream Codes");
    }

    // บันทึก channels.js (ไฟล์หลัก)
    const releaseChannels = await lock(channelsFilePath);
    try {
      await fsPromises.writeFile(
        channelsFilePath,
        `module.exports = ${JSON.stringify(importedChannels, null, 2)};`
      );
      channelsCache = { data: importedChannels, timestamp: Date.now(), maxSize: channelsCache.maxSize };
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("channels-updated", importedChannels);
        mainWindow.webContents.send("import-complete");
      }
    } finally {
      await releaseChannels();
    }

    // สร้างชื่อไฟล์ใหม่สำหรับ xtream.js ด้วย timestamp
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const xtreamFileName = `xtream_${timestamp}.js`;
    const xtreamFilePath = path.join(userDataPath, xtreamFileName);

    // สร้างไฟล์ xtream.js เปล่าก่อน ถ้ายังไม่มี
    if (!fs.existsSync(xtreamFilePath)) {
      await fsPromises.writeFile(xtreamFilePath, `module.exports = [];`, "utf-8");
      log(`Created initial ${xtreamFileName} at ${xtreamFilePath}`);
    }

    // บันทึก xtream.js ใหม่
    const releaseXtream = await lock(xtreamFilePath);
    try {
      await fsPromises.writeFile(
        xtreamFilePath,
        `module.exports = ${JSON.stringify(importedChannels, null, 2)};`
      );
      log(`Saved Xtream channels to ${xtreamFilePath}`);
      
      // เพิ่มไฟล์ใหม่เข้าไปใน importedFiles
      addImportedFile(xtreamFilePath, "js");
      store.set("lastChannelsPath", xtreamFilePath);
    } finally {
      await releaseXtream();
    }

    // เก็บข้อมูลการเชื่อมต่อ (ไม่มีการรีเฟรชอัตโนมัติ)
    store.set("xtreamConfig", { url, username, password });

    log(`Imported ${importedChannels.length} channels from Xtream Codes`);
    return importedChannels;
  } catch (error) {
    log(`Failed to import channels from API: ${error.message}`, "error");
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("import-complete");
    }
    throw error;
  }
});


app.on("ready", async () => {
  log("App is ready");
  await ensureChannelsFileExists();
session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const channels = channelsCache.data || [];
    const channel = channels.find((ch) => details.url.includes(ch.file));
    details.requestHeaders["Referer"] =
      channel?.httpOptions?.referrer || "https://dookeela.live";
    details.requestHeaders["User-Agent"] =
      channel?.httpOptions?.userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
    callback({ requestHeaders: details.requestHeaders });
  });

  await createWindow();
  checkForUpdatesAuto();

  const importedFiles = getImportedFiles();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("imported-files-updated", importedFiles);
    log(`Sent initial imported files: ${importedFiles.length} items`);
  }
});

app.on("window-all-closed", () => {
  log("All windows closed");
  if (proxyServerInstance && proxyServerInstance.isRunning()) {
    proxyServerInstance.stop();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    log("App activated, creating new window");
    await createWindow();
  }
});

app.on("before-quit", async () => {
  log("App is quitting");
  if (proxyServerInstance && proxyServerInstance.isRunning()) {
    proxyServerInstance.stop();
  }
  await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms
});

process.on("uncaughtException", (error) => {
  log(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  showError(`Uncaught Exception: ${error.message}`);
});

process.on("unhandledRejection", (reason, promise) => {
  log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, "error");
  showError(`Unhandled Rejection: ${reason}`);
});
		
		

const { contextBridge, ipcRenderer, clipboard } = require("electron"); // เพิ่ม clipboard
const fs = require("fs");
const log = (message, level = "info") => {
  console[level](`[Preload] ${message}`);
};

const listeners = {};

contextBridge.exposeInMainWorld("electronAPI", {
	
	
	importChannelsFromApi: (config) =>
    ipcRenderer.invoke("import-channels-from-api", config).catch((err) => {
      log(`Failed to import channels from API: ${err.message}`, "error");
      throw err;
    }),
	onImportStart: (callback) => ipcRenderer.on("import-start", callback),
  onImportProgress: (callback) => ipcRenderer.on("import-progress", callback),
  onImportComplete: (callback) => ipcRenderer.on("import-complete", callback),
	
on: (channel, callback) => ipcRenderer.on(channel, (event, ...args) => callback(event, ...args)),	
  // คงฟังก์ชันเดิมไว้ทั้งหมด
  saveImageFile: (base64Data, fileName) => {
    return ipcRenderer.invoke("save-image-file", { base64Data, fileName }).catch((err) => {
      log(`Failed to save image: ${err.message}`, "error");
      throw err;
    });
  },

  log: (message, level) => ipcRenderer.send("log-message", { message, level }),

  startProxy: (channelUrl) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.send("start-proxy", channelUrl);
      ipcRenderer.once("proxy-started", (event, port) => resolve(port));
      ipcRenderer.once("proxy-error", (event, error) => reject(new Error(error)));
    });
  },

  stopProxy: () => {
    return new Promise((resolve) => {
      ipcRenderer.send("stop-proxy");
      ipcRenderer.once("proxy-stopped", () => resolve());
    });
  },

  onProxyStarted: (callback) => {
    ipcRenderer.on("proxy-started", (event, port) => callback(port));
  },

  onProxyStopped: (callback) => {
    ipcRenderer.on("proxy-stopped", () => callback());
  },

  getM3u8: (channel) => ipcRenderer.invoke("get-m3u8", channel),

  on: (channel, callback) => ipcRenderer.on(channel, callback),
  
  getYouTubeFormats: (videoId) => ipcRenderer.invoke("get-youtube-formats", videoId),
    downloadYouTube: (videoId, formatId, outputPath) => 
        ipcRenderer.invoke("download-youtube", { videoId, formatId, outputPath }),
  
  

  // Screenshot API
  captureScreenshot: () =>
    ipcRenderer.invoke("capture-screenshot").catch((err) => {
      log(`Failed to capture screenshot: ${err.message}`, "error");
      throw err;
    }),

  saveScreenshot: (base64Data) =>
    ipcRenderer.invoke("save-screenshot", base64Data).catch((err) => {
      log(`Failed to save screenshot: ${err.message}`, "error");
      throw err;
    }),

  // Folder Dialog API
  openFolderDialog: () =>
    ipcRenderer.invoke("open-folder-dialog").catch((err) => {
      log(`Failed to open folder dialog: ${err.message}`, "error");
      throw err;
    }),

  onFolderMediaSelected: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onFolderMediaSelected callback must be a valid function", "error");
      return;
    }
    listeners["folder-media-selected"] = (event, files) => {
      log(`Folder media selected event received: ${files.length} files`);
      callback(files);
    };
    ipcRenderer.on("folder-media-selected", listeners["folder-media-selected"]);
  },

  onTriggerOpenFolder: (callback) =>
    ipcRenderer.on("trigger-open-folder", callback),

  // Stream Prompt API
  onShowStreamPrompt: (callback) =>
    ipcRenderer.on("show-stream-prompt", callback),

  sendStreamUrl: (url) => {
    ipcRenderer.send("open-stream-url", url);
    log(`Sent stream URL: ${url}`);
  },

  // Channel Management API
  getChannels: () =>
    ipcRenderer.invoke("get-channels").catch((err) => {
      log(`Failed to get channels: ${err.message}`, "error");
      throw err;
    }),

  setChannels: (channels) => {
    ipcRenderer.send("set-channels", channels);
    log(`Channels set: ${channels.length} items`);
  },

  updateChannels: (channels) => {
    ipcRenderer.send("update-channels", channels);
    log(`Channels updated: ${channels.length} items`);
  },

  onChannelsUpdated: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onChannelsUpdated callback must be a valid function", "error");
      return;
    }
    listeners["channels-updated"] = (event, channels) => {
      if (!Array.isArray(channels)) {
        log("Received channels data is not an array", "error");
        callback([]);
        return;
      }
      log(`Channels updated event received: ${channels.length} items`);
      callback(channels);
    };
    ipcRenderer.on("channels-updated", listeners["channels-updated"]);
  },

  sortChannels: (order) => {
    ipcRenderer.send("sort-channels", order);
    log(`Sorting channels requested: ${order}`);
  },

  // Favorites API
  getFavorites: () =>
    ipcRenderer.invoke("get-favorites").catch((err) => {
      log(`Failed to get favorites: ${err.message}`, "error");
      throw err;
    }),

  setFavorites: (favorites) => {
    ipcRenderer.send("set-favorites", favorites);
    log(`Favorites set: ${favorites.length} items`);
  },

  onFavoritesUpdated: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onFavoritesUpdated callback must be a valid function", "error");
      return;
    }
    listeners["favorites-updated"] = (event, favorites) => {
      log(`Favorites updated event received: ${favorites.length} items`);
      callback(favorites);
    };
    ipcRenderer.on("favorites-updated", listeners["favorites-updated"]);
  },

  // Import URL API
  sendImportUrlResponse: (url) => {
    ipcRenderer.send("import-url-response", url);
    log(`Sent import URL response: ${url}`);
  },

  onShowImportUrlPopup: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onShowImportUrlPopup callback must be a valid function", "error");
      return;
    }
    listeners["show-import-url-popup"] = (event) => {
      log("Show import URL popup event received");
      callback();
    };
    ipcRenderer.on("show-import-url-popup", listeners["show-import-url-popup"]);
  },

  // Language and Theme API
  onChangeLanguage: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onChangeLanguage callback must be a valid function", "error");
      return;
    }
    listeners["change-language"] = (event, lang) => {
      log(`Language change event received: ${lang}`);
      callback(lang);
    };
    ipcRenderer.on("change-language", listeners["change-language"]);
  },

  onChangeTheme: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onChangeTheme callback must be a valid function", "error");
      return;
    }
    listeners["change-theme"] = (event, theme) => {
      log(`Theme change event received: ${theme}`);
      callback(theme);
    };
    ipcRenderer.on("change-theme", listeners["change-theme"]);
  },

  // External URL and M3U8 API
  openExternal: (url) => {
    ipcRenderer.send("open-external", url);
    log(`Opening external URL: ${url}`);
  },

  getM3u8: (channel) =>
    ipcRenderer.invoke("get-m3u8", channel).catch((err) => {
      log(`Failed to get m3u8: ${err.message}`, "error");
      throw err;
    }),

  // Proxy API
  onProxyError: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onProxyError callback must be a valid function", "error");
      return;
    }
    listeners["proxy-error"] = (event, error) => {
      log(`Proxy error event received: ${error}`, "error");
      callback(error);
    };
    ipcRenderer.on("proxy-error", listeners["proxy-error"]);
  },

  onProxyRestarted: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onProxyRestarted callback must be a valid function", "error");
      return;
    }
    listeners["proxy-restarted"] = (event) => {
      log("Proxy restarted event received");
      callback();
    };
    ipcRenderer.on("proxy-restarted", listeners["proxy-restarted"]);
  },

  // Imported Files API
  getImportedFiles: () =>
    ipcRenderer.invoke("get-imported-files").catch((err) => {
      log(`Failed to get imported files: ${err.message}`, "error");
      throw err;
    }),

  selectImportedFile: (filePath) => {
    ipcRenderer.send("select-imported-file", filePath);
    log(`Selecting imported file: ${filePath}`);
  },

  removeImportedFile: (filePath) => {
    ipcRenderer.send("remove-imported-file", filePath);
    log(`Removing imported file: ${filePath}`);
  },

  onSelectedFileUpdated: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onSelectedFileUpdated callback must be a valid function", "error");
      return;
    }
    listeners["selected-file-updated"] = (event, filePath) => {
      log(`Selected file updated event received: ${filePath}`);
      callback(filePath);
    };
    ipcRenderer.on("selected-file-updated", listeners["selected-file-updated"]);
  },

  onImportedFilesUpdated: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onImportedFilesUpdated callback must be a valid function", "error");
      return;
    }
    listeners["imported-files-updated"] = (event, files) => {
      log(`Imported files updated event received: ${files.length} files`);
      callback(files);
    };
    ipcRenderer.on("imported-files-updated", listeners["imported-files-updated"]);
  },

  // Window and View Mode API
  onWindowMaximized: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onWindowMaximized callback must be a valid function", "error");
      return;
    }
    listeners["window-maximized"] = (event, isMaximized) => {
      log(`Window maximized event received: ${isMaximized}`);
      callback(isMaximized);
    };
    ipcRenderer.on("window-maximized", listeners["window-maximized"]);
  },

  setViewMode: (mode) => ipcRenderer.send("set-view-mode", mode),
  getViewMode: () => ipcRenderer.invoke("get-view-mode"),

  // File and Stream API
  openFileDialog: () =>
    ipcRenderer.invoke("open-file-dialog").catch((err) => {
      log(`Failed to open file dialog: ${err.message}`, "error");
      throw err;
    }),

  openStreamUrl: (url) => {
    ipcRenderer.send("open-stream-url", url);
    log(`Sent stream URL: ${url}`);
  },

  onMediaSelected: (callback) => {
    if (!callback || typeof callback !== "function") {
      log("onMediaSelected callback must be a valid function", "error");
      return;
    }
    listeners["media-selected"] = (event, media) => {
      log(`Media selected event received: ${JSON.stringify(media)}`);
      callback(media);
    };
    ipcRenderer.on("media-selected", listeners["media-selected"]);
  },

  // Player Quality and Error Reporting API
  switchToLowerQualityStream: (currentUrl) => {
    ipcRenderer.send("switch-to-lower-quality-stream", currentUrl);
    log(`Requested lower quality stream for: ${currentUrl}`);
  },

  reportPlayerError: (errorDetails) => {
    ipcRenderer.send("report-player-error", errorDetails);
    log(`Reported player error: ${JSON.stringify(errorDetails)}`, "error");
  },

  // เพิ่ม Download API จากโค้ดใหม่
  invoke: (channel, data) => ipcRenderer.invoke(channel, data),

  downloadVideo: (url, outputPath, duration) => {
    return ipcRenderer.invoke("download-video", { url, outputPath, duration }).catch((err) => {
      log(`Failed to download video: ${err.message}`, "error");
      throw err;
    });
  },

  stopDownload: () => {
    return ipcRenderer.invoke("stop-download").catch((err) => {
      log(`Failed to stop download: ${err.message}`, "error");
      throw err;
    });
  },

  onDownloadProgress: (callback) => {
    const listener = (event, progress) => callback(progress);
    listeners["download-progress"] = listener;
    ipcRenderer.on("download-progress", listener);
  },

  onDownloadComplete: (callback) => {
    const listener = (event, filePath) => callback(filePath);
    listeners["download-complete"] = listener;
    ipcRenderer.on("download-complete", listener);
  },

  onDownloadError: (callback) => {
    const listener = (event, error) => callback(error);
    listeners["download-error"] = listener;
    ipcRenderer.on("download-error", listener);
  },

  // เพิ่มฟังก์ชันคลิปบอร์ด
  clipboardReadText: () => clipboard.readText(),
});

window.addEventListener("unload", () => {
  Object.keys(listeners).forEach((channel) => {
    ipcRenderer.removeListener(channel, listeners[channel]);
  });
  log("Cleaned up all IPC listeners on window unload");
});

// เพิ่มการ log เมื่อ preload โหลด
log("Preload script initialized");
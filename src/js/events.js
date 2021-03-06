(function () {
  window.onerror = function () {
    var msgError = msg + ' in ' + url + ' (line: ' + line + ')';
    if (config.DEBUG)
      alert(msgError);

    statSend("Usage", "Error", msgError);
  };

  // total usage stat
  statSend("Users", "Total", config.VERSION);
  if (localStorage.type === "sync")
    statSend("Usage", "Syncing");

  // migration process
  chrome.runtime.onInstalled.addListener(function (details) {
    switch (details.reason) {
      case "install":
        statSend("Users", "Install");
        break;

      case "update":
        // clear downloaded libraries on update
        deleteDownloadedLibs();

        if (/^0\./.test(details.previousVersion) || /^1\./.test(details.previousVersion))
          migrateFrom1x();

        if (details.previousVersion === "2.0")
          migrateFrom20();

        if (config.VERSION !== details.previousVersion)
          statSend("Users", "Update", {prev: details.previousVersion, cur: config.VERSION});

        break;
    }
  });

  // messages listener
  chrome.runtime.onMessage.addListener(function (req, sender, sendResponse) {
    switch (req.action) {
      case "search":
        searchFreaks(req.url, sendResponse);
        return true;
        break;

      case "changeStorageType":
        localStorage.type = req.sync ? "sync" : "local";

        if (req.sync) {
          chrome.storage.local.get(null, function (obj) {
            chrome.storage.sync.set(obj, function () {
              chrome.storage.local.clear(sendResponse);
            });
          });
        } else {
          chrome.storage.sync.get(null, function (obj) {
            chrome.storage.local.set(obj, function () {
              chrome.storage.sync.clear(sendResponse);
            });
          });
        }

        return true;
        break;

      case "content":
        // search for scripts on this page
        searchFreaks(req.url, function (res) {
          var chromeInject = (localStorage.inject !== "dom");
          var loadLibsTasks = {
            js: [],
            css: []
          };

          ["libs_all", "libs_origin", "libs_page"].forEach(function (tabScope) {
            if (!res[tabScope])
              return;

            for (var i = 0; i < res[tabScope].length; i++) {
              (function (libraryURL, taskType) {
                statSend("Usage", "Libs", libraryURL);

                loadLibsTasks[taskType].push(function (callback) {
                  requestExternalContent(libraryURL, callback);
                });
              })(res[tabScope][i], /\.js$/i.test(res[tabScope][i]) ? "js" : "css");
            }
          });

          parallel({
            js: function (callback) {
              // parallelize JS libraries loading
              parallel(loadLibsTasks.js, function (libs) {
                var scriptData = libs.join("\n\n");
                var hasLocalFreaks = false;

                // append js data
                ["all", "origin", "page"].forEach(function (scope) {
                  var key = "js_" + scope;
                  if (!res[key])
                    return;

                  hasLocalFreaks = true;
                  scriptData += "\n\n" + res[key];
                });

                if (hasLocalFreaks)
                  statSend("Usage", "Javascript");

                if (scriptData.length && chromeInject)
                  chrome.tabs.executeScript(sender.tab.id, {code: scriptData});

                callback(scriptData);
              });
            },
            css: function (callback) {
              // parallelize CSS libraries loading
              parallel(loadLibsTasks.css, function (libs) {
                var stylesData = libs.join("\n\n");
                var hasLocalFreaks = false;

                // append js data
                ["all", "origin", "page"].forEach(function (scope) {
                  var key = "css_" + scope;
                  if (!res[key])
                    return;

                  hasLocalFreaks = true;
                  stylesData += "\n\n" + res[key];
                });

                if (hasLocalFreaks)
                  statSend("Usage", "CSS");

                if (stylesData.length && chromeInject)
                  chrome.tabs.insertCSS(sender.tab.id, {code: stylesData});

                callback(stylesData);
              });
            }
          }, function (results) {
            results.chrome = chromeInject;
            sendResponse(results);
          });
        });

        return true;
        break;
    }
  });

  // custom statistics @ google analytics
  function statSend(category, action, optLabel, optValue) {
    var argsArray = Array.prototype.map.call(arguments, function (element) {
      return (typeof element === "string") ? element : JSON.stringify(element);
    });

    try {
      window._gaq.push(["_trackEvent"].concat(argsArray));
    } catch (e) {}
  }

  // @see https://npmjs.org/package/async#parallel
  function parallel(tasks, callback) {
    var isNamedQueue = !Array.isArray(tasks);
    var tasksKeys = isNamedQueue ? Object.keys(tasks) : new Array(tasks.length);
    var resultsData = isNamedQueue ? {} : [];

    if (!tasksKeys.length)
      return callback(resultsData);

    var tasksTotalNum = tasksKeys.length;
    var tasksProcessedNum = 0;

    (function processTasks() {
      if (!tasksKeys.length)
        return;

      var taskIndex = tasksKeys.pop() || tasksKeys.length;
      tasks[taskIndex](function (data) {
        resultsData[taskIndex] = data;
        tasksProcessedNum += 1;

        if (tasksProcessedNum === tasksTotalNum)
          return callback(resultsData);

        processTasks();
      });

      processTasks();
    })();
  }

  // get all freaks for page
  function searchFreaks(url, callback) {
    var storageType = localStorage.type === "sync" ? "sync" : "local";
    var parseLink = document.createElement("a");
    parseLink.setAttribute("href", url);

    var tasks = {};
    ["all", "origin", "page"].forEach(function (scope) {
      ["js", "css", "libs"].forEach(function (tab) {
        tasks[tab + "_" + scope] = function (callback) {
          var storageKey = tab + "-";
          switch (scope) {
            case "all": storageKey += "*"; break;
            case "origin": storageKey += parseLink.origin; break;
            case "page": storageKey += url; break;
          }

          chrome.storage[storageType].get(storageKey, function (obj) {
            callback(obj[storageKey]);
          });
        };
      });
    })

    parallel(tasks, function (results) {
      var output = {};
      for (var key in results) {
        if (results[key]) {
          output[key] = results[key];
        }
      }

      callback(output);
    });
  }

  // migrate to 2.x
  // @see https://github.com/1999/controlfreak/issues/8
  function migrateFrom1x() {
    var saveData = {};
    var hasFreaks = false;
    var matches;

    for (var key in localStorage) {
      matches = key.match(/^(js|css|libs)-(.+)/);
      if (!matches)
        continue;

      if (!/^(https?|ftps?|chrome\-extension|chrome):\/\//.test(matches[2]) && matches[2] !== "*")
        matches[2] = "http://" + matches[2];

      try {
        saveData[matches[1] + "-" + matches[2]] = JSON.parse(localStorage[key]);
        hasFreaks = true;
      } catch (ex) {}
    }

    if (hasFreaks) {
      chrome.storage.local.set(saveData);
      localStorage.inject = "dom";
    }

    // show update notification
    var updateText = chrome.i18n.getMessage("migrateText20");
    var notification = window.webkitNotifications.createNotification(chrome.runtime.getURL("images/system48.png"), "Control Freak", updateText);

    notification.onclick = function () {
      statSend("Usage", "Click 2.x notification");

      notification.cancel();
      chrome.tabs.create({url: "https://plus.google.com/111376663194937437149/posts/WaQwVYq1EAT"});
    };

    notification.show();
    statSend("Usage", "Show 2.x notification");

    window.setTimeout(function() {
      notification.cancel();
    }, 10000);
  }

  // migrate from 2.0
  // @see https://github.com/1999/controlfreak/issues/14
  function migrateFrom20() {
    // localStorage.type is used in ControlFreak 2.0
    if (localStorage.length <= 1)
      return;

    localStorage.inject = "dom";

    // show update notification
    var updateText = chrome.i18n.getMessage("migrateText21");
    var notification = window.webkitNotifications.createNotification(chrome.runtime.getURL("images/system48.png"), "Control Freak", updateText);

    notification.onclick = function () {
      statSend("Usage", "Click 2.1 notification");

      notification.cancel();
      chrome.tabs.create({url: "https://plus.google.com/111376663194937437149/posts/Bn4hn8T3op7"});
    };

    notification.show();
    statSend("Usage", "Show 2.1 notification");

    window.setTimeout(function() {
      notification.cancel();
    }, 10000);
  }

  // clear fs.root from downloaded files
  function deleteDownloadedLibs() {
    requestFileSystem(function (err, fsLink) {
      if (err)
        return;

      var reader = fsLink.root.createReader();
      reader.readEntries(function (results) {
        for (var i = 0; i < results.length; i++) {
          results.item(i).remove(function () {});
        }
      });
    });
  }

  // xmlhttprequests
  function request(url, callback) {
    var xhr = new XMLHttpRequest;
    xhr.open("GET", url, true);

    xhr.onload = function () {
      callback(null, {
        status: xhr.status,
        expires: xhr.getResponseHeader("expires"),
        data: xhr.responseText
      });
    };

    xhr.onerror = xhr.onabort = function (evt) {
      callback("Error: " + evt.type)
    };

    xhr.send();
  }

  // get filesystem point
  function requestFileSystem(callback) {
    (window.webkitRequestFileSystem || window.requestFileSystem)(window.PERSISTENT, 0, function (windowFsLink) {
      callback(null, windowFsLink);
    }, function (err) {
      callback("Filesystem not available: " + err);
    });
  }

  // try to get URL contents with proper cache headers
  function requestExternalContent(url, callback) {
    var errComment = "/* Unable to load " + url + " */\n";

    requestFileSystem(function (err, fsLink) {
      if (err) {
        return request(url, function (err, res) {
          callback(err ? errComment : res.data);
        });
      }

      var fileName = url.replace(/[^\w]+/g, "") + ".json";
      var requestCallback = function (err, res) {
        if (err)
          return callback(errComment);

        if (!/^2/.test(res.status))
          return callback(errComment + res.data);

        fsLink.root.getFile(fileName, {create: true}, function (fileEntry) {
          fileEntry.createWriter(function (fileWriter) {
            delete res.status;
            res.expires = res.expires ? (new Date(res.expires)).getTime() : Date.now();
            var blob = new Blob([JSON.stringify(res, null, "\t")], {type: "text/plain"});

            fileWriter.write(blob);
            callback(res.data);
          }, function (err) {
            callback(res.data);
          });
        }, function (err) {
          callback(res.data);
        });
      };

      fsLink.root.getFile(fileName, {create: false}, function (fileEntry) {
        fileEntry.file(function (file) {
          var reader = new FileReader;

          reader.onloadend = function (evt) {
            try {
              var cacheData = JSON.parse(reader.result);
              if (cacheData.expires > Date.now()) {
                return callback(cacheData.data);
              }
            } catch (ex) {}

            request(url, requestCallback);
          };

          reader.readAsText(file);
        }, function (err) {
          request(url, requestCallback);
        });
      }, function (err) {
        request(url, requestCallback);
      });
    });
  }

  // parse GreaseMonkey userscript metadata
  function parseMetadataBlock(contents) {
    var output = {};
    var matches = contents.match(/\/\/\s==UserScript==(.|[\r\n])+\/\/\s==\/UserScript==/gm);
    if (!matches)
      return output;

    var regex = /\/\/\s@(require|include|exclude|match)[^\w]*?(.+)/gm;
    var execMatches;
    while (execMatches = regex.exec(matches[0])) {
      output[execMatches[1]] = output[execMatches[1]] || [];
      output[execMatches[1]].push(execMatches[2].trim());
    }

    return output;
  }
})();

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const apiLimited         = false;
const showURLonRadioList = true;

// ─── STATE ───────────────────────────────────────────────────────────────────

let alarmOn  = false;
let mapZoom  = 15;
let alarm1;
let prevVolume;

// ─── DOM REFS ────────────────────────────────────────────────────────────────

const radioList         = document.getElementById("radioList");
const currentlyPlaying  = document.getElementById("currentlyPlaying");
const radioStatus       = document.getElementById("radioStatus");
const radioDecibels     = document.getElementById("radioDecibels");
const audioPlayer       = document.getElementById("playerID");
const alarmNeon         = document.getElementById("alarm-neon");
const alarmOnButton     = document.getElementById("alarm-activate");
const alarmHours        = document.getElementById("alarm-hours");
const alarmMinutes      = document.getElementById("alarm-minutes");
const alarmSeconds      = document.getElementById("alarm-seconds");
const alarmsGeolocation = document.getElementById("alarms-geolocation");

// ─── MAIN CLOCK ──────────────────────────────────────────────────────────────

const MONTH_NAMES = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
let fecha = new Date();

const mainClockDay         = document.getElementById("day");
const mainClockMonth       = document.getElementById("month");
const mainClockYear        = document.getElementById("year");
const mainClockHourMinutes = document.getElementById("hour-minutes");

// Updates a clock section, spinning only the digits that actually changed.
function updateClockSection(element, newValue) {
    const newChars = String(newValue).split('');
    const existing = element.querySelectorAll('.main-clock-digit');

    if (existing.length !== newChars.length) {
        element.innerHTML = newChars
            .map(c => `<div class="main-clock-digit">${c}</div>`)
            .join('');
        return;
    }

    newChars.forEach((char, i) => {
        if (existing[i].textContent !== char) {
            existing[i].textContent = char;
            existing[i].classList.remove('drum-spin');
            void existing[i].offsetWidth;   // force reflow to restart animation
            existing[i].classList.add('drum-spin');
        }
    });
}

function refreshMainClock() {
    fecha = new Date();
    updateClockSection(mainClockDay,         fecha.toDateString().slice(8, -5).trim());
    updateClockSection(mainClockMonth,       MONTH_NAMES[fecha.getMonth()]);
    updateClockSection(mainClockYear,        String(fecha.getFullYear()));
    updateClockSection(mainClockHourMinutes, fecha.toTimeString().slice(0, 5).replace(':', ''));
}

refreshMainClock();

// ─── RADIO LIST ──────────────────────────────────────────────────────────────

// Virtual fixed-window list: DOM never scrolls. We slide a view over the full
// station array and overwrite only the visible row contents when navigating.

const RADIO_ROWS = 5;

let radioItems     = [];
let radioViewTop   = 0;
let radioHighlight = 0;
let radioSelected  = -1;
let lastHoveredIdx = -1;

fetch('./radioList.json')
    .then(r => r.json())
    .then(jsonData => {
        radioItems   = Object.entries(jsonData).map(([name, url]) => ({ name, url }));
        radioViewTop = Math.min(
            parseInt(getCookie("radioViewTop")) || 0,
            Math.max(0, radioItems.length - RADIO_ROWS)
        );
        radioSelected  = parseInt(getCookie("selectedRadioID")) || 0;
        radioHighlight = Math.max(radioViewTop, Math.min(radioSelected, radioViewTop + RADIO_ROWS - 1));
        renderRadioWindow();
        // Kick off metadata poll if a station is already "selected" from cookie
        if (radioSelected >= 0) startMetaPoll(radioItems[radioSelected].url);
        console.log("Radio list loaded.");
    });

function renderRadioWindow() {
    radioList.querySelectorAll('.radio-item').forEach((el, row) => {
        const absIdx = radioViewTop + row;
        if (absIdx >= radioItems.length) {
            el.textContent = '';
            el.removeAttribute('id');
            el.dataset.absIdx = '';
            return;
        }
        const { name, url } = radioItems[absIdx];
        el.innerHTML      = showURLonRadioList ? `${name}<br>${url}` : name;
        el.dataset.absIdx = absIdx;

        if      (absIdx === radioSelected)  el.id = 'selected';
        else if (absIdx === radioHighlight) el.id = 'hovered';
        else                                el.removeAttribute('id');
    });
}

function moveRadioCursor(dir) {
    if (!radioItems.length) return;
    const newHighlight = Math.max(0, Math.min(radioItems.length - 1, radioHighlight + dir));
    if (newHighlight === radioHighlight) return;

    radioHighlight = newHighlight;
    if (radioHighlight < radioViewTop)                   radioViewTop = radioHighlight;
    else if (radioHighlight >= radioViewTop + RADIO_ROWS) radioViewTop = radioHighlight - RADIO_ROWS + 1;
    setCookie("radioViewTop", radioViewTop, 365);

    playAudio('./snd/pipBoyTick.mp3');
    renderRadioWindow();
}

radioList.addEventListener("click", function (e) {
    const li = e.target.closest('li.radio-item');
    if (!li || li.dataset.absIdx === '') return;
    const absIdx = parseInt(li.dataset.absIdx);
    if (isNaN(absIdx)) return;

    radioHighlight = absIdx;
    radioSelected  = absIdx;
    
    // Legacy version: HTTP-only streams got blocked on HTTPS pages by modern browsers
    //audioPlayer.src = radioItems[absIdx].url;

    // Production version: routes HTTP/HTTPS audio streams through a Cloudflare Worker HTTPS proxy (HTTP-only gets blocked on HTTPS pages by modern browsers!)
    let proxiedURL = "https://http-to-https-proxy.ivanao1992.workers.dev/?url=" + encodeURIComponent(radioItems[absIdx].url);
    console.log("proxiedURL: ", proxiedURL);
    audioPlayer.src = proxiedURL;

    setCookie("selectedRadioID", absIdx, 365);
    renderRadioWindow();
    startMetaPoll(radioItems[absIdx].url);
    playAudio('./snd/pipBoyTick.mp3');
}, false);

radioList.addEventListener("mousemove", function (e) {
    const li = e.target.closest('li.radio-item');
    if (!li || li.dataset.absIdx === '') return;
    const absIdx = parseInt(li.dataset.absIdx);
    if (isNaN(absIdx) || absIdx === lastHoveredIdx) return;

    lastHoveredIdx = absIdx;
    radioHighlight = absIdx;
    renderRadioWindow();
    playAudio('./snd/pipBoyTick.mp3');
}, false);

radioList.addEventListener("mouseleave", () => { lastHoveredIdx = -1; }, false);

radioList.addEventListener("wheel", function (e) {
    e.preventDefault();
    moveRadioCursor(e.deltaY > 0 ? 1 : -1);
}, { passive: false });

// ─── STREAM METADATA ─────────────────────────────────────────────────────────

// Polls the playing station's metadata endpoint every 15 s and shows the
// current track/artist in a scrolling CRT ticker below the station list.
// Tries three common server types; silently gives up if all are CORS-blocked.

let metaPollInterval = null;
let currentMetaUrl   = null;   // avoids restarting the poll for the same station

function startMetaPoll(streamUrl) {
    if (streamUrl === currentMetaUrl) return;
    currentMetaUrl = streamUrl;
    clearInterval(metaPollInterval);
    metaPollInterval = null;
    currentlyPlaying.style.display = 'none';

    let baseUrl;
    try {
        // Strip trailing ; and any mount path — we want just protocol + host
        const u = new URL(streamUrl.replace(/;.*$/, ''));
        baseUrl = `${u.protocol}//${u.host}`;
    } catch { return; }

    async function fetchMeta() {
        const opt = { mode: 'cors', cache: 'no-store' };

        // Shoutcast v1: plain-text current song
        try {
            const r = await fetch(`${baseUrl}/currentsong`, opt);
            if (r.ok) {
                const text = (await r.text()).trim().split('\n')[0];
                if (text) { showMeta(text); return; }
            }
        } catch {}

        // Icecast: JSON status
        try {
            const r = await fetch(`${baseUrl}/status-json.xsl`, opt);
            if (r.ok) {
                const data = await r.json();
                const src  = data?.icestats?.source;
                const title = Array.isArray(src) ? src[0]?.title : src?.title;
                if (title) { showMeta(title); return; }
            }
        } catch {}

        // Shoutcast v2: stats JSON
        try {
            const r = await fetch(`${baseUrl}/stats?sid=1&json=3`, opt);
            if (r.ok) {
                const data = await r.json();
                const title = data?.streams?.[0]?.songtitle;
                if (title) { showMeta(title); return; }
            }
        } catch {}

        // Nothing worked (likely CORS-blocked) — stay hidden
        currentlyPlaying.style.display = 'none';
    }

    fetchMeta();
    metaPollInterval = setInterval(fetchMeta, 15_000);
}

function showMeta(text) {
    // Scroll duration: ~0.28 s per character so all text scrolls at the same px/s speed
    const duration = Math.max(8, text.length * 0.28).toFixed(1);
    currentlyPlaying.innerHTML =
        `<span class="meta-ticker" style="animation-duration:${duration}s">${escapeHTML(text)}</span>`;
    currentlyPlaying.style.display = 'block';
}

// Also restart the poll if playback resumes after buffering / reconnect
audioPlayer.addEventListener("playing", () => {
    updateRadioStatus("Playing");
    if (radioSelected >= 0 && radioItems.length > 0) {
        startMetaPoll(radioItems[radioSelected].url);
    }
});

// ─── COOKIES ─────────────────────────────────────────────────────────────────

function setCookie(cname, cvalue, exdays) {
    const d = new Date();
    d.setTime(d.getTime() + (exdays * 24 * 60 * 60 * 1000));
    document.cookie = `${cname}=${cvalue};expires=${d.toUTCString()};path=/;SameSite=Lax`;
}

function getCookie(cname) {
    const name = cname + "=";
    for (let c of decodeURIComponent(document.cookie).split(';')) {
        c = c.trimStart();
        if (c.startsWith(name)) return c.substring(name.length);
    }
    return "";
}

// ─── MENU NAVIGATION ─────────────────────────────────────────────────────────

var currentMenu = getCookie("currMenu") || "button-radio";
updateCurrMenu(currentMenu);

function updateCurrMenu(menu) {
    const scanlinesAnim = document.getElementById("pip-screen-scanlines-anim");
    scanlinesAnim.style.animationPlayState = "running";
    scanlinesAnim.style.display = "inline";

    switch (menu) {
        case "button-status":
            document.getElementById("menu-status").style.display = "inline";
            break;
        case "button-radio":
            document.getElementById("menu-radio").style.display = "inline";
            break;
        case "button-automaps":
            document.getElementById("menu-automaps").style.display = "inline";
            if (leafletMap) leafletMap.invalidateSize();
            // Map-specific: shows coordinates + inits/updates Leaflet
            getGeoLocationForMap();
            break;
        case "button-archives":
            document.getElementById("menu-archives").style.display = "inline";
            renderNotes();
            break;
        case "button-close":
            document.getElementById("menu-close").style.display = "inline";
            document.getElementById("menu-close").style.visibility = "hidden";
            scanlinesAnim.style.animationPlayState = "paused";
            scanlinesAnim.style.display = "none";
            break;
        case "button-alarms":
            document.getElementById("menu-alarms").style.display = "inline";
            refreshAlarms();
            refreshAlarmsMenuClock();
            if (!alarmOn) refreshAlarmSetTEMP();
            // Alarms-specific: only needs sunrise/sunset data, NOT the map
            fetchSunriseSunset();
            break;
    }

    if (menu !== "button-close") setCookie("currMenu", menu, 365);
}

const menuScreens = document.getElementsByClassName("menu-screen");
const pipButtons  = document.getElementsByClassName("pip-button");

for (const btn of pipButtons) {
    btn.addEventListener('click', function () {
        playAudio('./snd/pipBoyTick.mp3');
        for (const screen of menuScreens) screen.style.display = "none";
        currentMenu = this.id;
        updateCurrMenu(currentMenu);
    }, false);
}

// ─── AUDIO PLAYER ────────────────────────────────────────────────────────────

// For audio files, not radio related
function playAudio(url) { new Audio(url).play(); }

audioPlayer.volume = parseFloat(getCookie("radioVolume")) || 0.5;
prevVolume = audioPlayer.volume;
updateDecibels();

function updateRadioStatus(string) { radioStatus.innerHTML = string; }

audioPlayer.addEventListener("loadstart", () => updateRadioStatus("Connecting..."));
audioPlayer.addEventListener("pause",     () => updateRadioStatus("Paused"));
// "playing" handler is above in STREAM METADATA section
audioPlayer.addEventListener("stalled",   () => updateRadioStatus("Data not available"));
audioPlayer.addEventListener("waiting",   () => updateRadioStatus("Buffering..."));

function updateDecibels() {
    const db = audioPlayer.volume > 0 ? 20 * Math.log10(audioPlayer.volume) : -Infinity;
    radioDecibels.innerHTML = isFinite(db) ? db.toFixed(2) + " dB" : "-∞ dB";
    setCookie("radioVolume", audioPlayer.volume.toFixed(4), 365);
}

// Volume in 0.5 dB steps (perceptually linear?)
const VOLUME_STEP_DB  = 0.5;
const VOLUME_FLOOR_DB = -60;

function changeVolumeByDB(deltaDB) {
    const currentDB = audioPlayer.volume > 0 ? 20 * Math.log10(audioPlayer.volume) : VOLUME_FLOOR_DB;
    const newDB     = Math.min(0, currentDB + deltaDB);
    audioPlayer.volume = newDB <= VOLUME_FLOOR_DB ? 0 : Math.pow(10, newDB / 20);
    updateDecibels();
}

let volumeSoundThrottle = null;
radioDecibels.addEventListener('wheel', function (event) {
    event.preventDefault();
    changeVolumeByDB((event.deltaY < 0 ? 1 : -1) * VOLUME_STEP_DB);
    if (!volumeSoundThrottle) {
        playAudio('./snd/pipBoyTick.mp3');
        volumeSoundThrottle = setTimeout(() => volumeSoundThrottle = null, 80);
    }
});

var touchStart = { y: 0 };
radioDecibels.addEventListener("touchstart", e => { touchStart.y = e.touches[0].pageY; }, false);
radioDecibels.addEventListener("touchmove", function (e) {
    const offset = touchStart.y - e.touches[0].pageY;
    audioPlayer.volume = Math.min(Math.max(0, audioPlayer.volume + offset * 0.0001), 1);
    updateDecibels();
}, false);
radioDecibels.addEventListener("touchend", () => {
    setCookie("radioVolume", audioPlayer.volume.toFixed(4), 365);
}, false);

// Double-click/tap to toggle mute
var tapedTwice = false;
radioDecibels.addEventListener("click", function (event) {
    if (!tapedTwice) { tapedTwice = true; setTimeout(() => tapedTwice = false, 300); return; }
    event.preventDefault();
    if (audioPlayer.volume > 0) { prevVolume = audioPlayer.volume; audioPlayer.volume = 0; }
    else                        { audioPlayer.volume = prevVolume; }
    updateDecibels();
});

// ─── ALARM CONTROLS ──────────────────────────────────────────────────────────

function makeAlarmFieldHandler(max) {
    return function (e) {
        const val = parseInt(e.target.innerHTML);
        e.target.innerHTML = String(val < max ? val + 1 : 0).padStart(2, "0");
        playAudio('./snd/pipBoyTick.mp3');
    };
}

alarmHours.addEventListener("click",   makeAlarmFieldHandler(23));
alarmMinutes.addEventListener("click", makeAlarmFieldHandler(59));
alarmSeconds.addEventListener("click", makeAlarmFieldHandler(59));

alarmOnButton.addEventListener("click", function () {
    alarmOn = !alarmOn;
    alarm1  = alarmOn ? new Alarma(`${alarmHours.innerHTML}:${alarmMinutes.innerHTML}:${alarmSeconds.innerHTML}`) : (alarm1.stopAlarm(), undefined);
    playAudio('./snd/pipBoyTick.mp3');
    refreshAlarms();
});

function refreshAlarms() {
    alarmOnButton.style.backgroundColor = alarmOn ? "rgb(0,255,0,0.5)" : "rgb(0,0,0,0)";
    alarmOnButton.style.color           = alarmOn ? "rgb(0,0,0,1)"     : "rgb(0,255,0,0.5)";
    alarmOnButton.innerHTML             = alarmOn ? "ON" : "OFF";
}

// ─── ALARMS MENU ─────────────────────────────────────────────────────────────

function refreshAlarmsMenuClock() {
    fecha = new Date();
    const timeStr = fecha.toTimeString().slice(0, 8);
    document.getElementById("now").innerHTML = "Now: " + timeStr;

    const svg        = document.getElementById("sunrise-sunset-bar-svg");
    const nowSVG     = document.getElementById("now-svg");
    const nowLineSVG = document.getElementById("now-line-svg");
    const x = clockToDayPercent(timeStr)
            - widthToPercent(nowSVG.getAttribute("width"), svg.getAttribute("width")) / 2 + "%";
    nowSVG.setAttribute("x", x);
    nowLineSVG.setAttribute("x2", x);
}

function refreshAlarmSetTEMP() {
    fecha = new Date();
    const t = fecha.toTimeString();
    alarmHours.innerHTML   = t.slice(0, 2);
    alarmMinutes.innerHTML = t.slice(3, 5);
    alarmSeconds.innerHTML = t.slice(6, 8);
}

function refreshSunriseSunsetBar(sunriseTime, sunsetTime) {
    const svg        = document.getElementById("sunrise-sunset-bar-svg");
    const sunriseSVG = document.getElementById("sunrise-svg");
    const sunsetSVG  = document.getElementById("sunset-svg");
    sunriseSVG.setAttribute("x",
        clockToDayPercent(sunriseTime) - widthToPercent(sunriseSVG.getAttribute("width"), svg.getAttribute("width")) / 2 + "%");
    refreshAlarmsMenuClock();
    sunsetSVG.setAttribute("x",
        clockToDayPercent(sunsetTime)  - widthToPercent(sunsetSVG.getAttribute("width"),  svg.getAttribute("width"))  / 2 + "%");
}

// ─── GEOLOCATION & MAP ───────────────────────────────────────────────────────

let leafletMap    = null;
let leafletMarker = null;

const DEFAULT_LAT = -34.9455289;
const DEFAULT_LNG = -57.9730931;

// Generic wrapper — calls onSuccess(position) or falls back to default coords
function requestPosition(onSuccess, onFailure) {
    if (!navigator.geolocation) {
        onSuccess({ coords: { latitude: DEFAULT_LAT, longitude: DEFAULT_LNG } });
        return;
    }
    navigator.geolocation.getCurrentPosition(onSuccess, onFailure || function () {
        onSuccess({ coords: { latitude: DEFAULT_LAT, longitude: DEFAULT_LNG } });
    });
}

// ── Alarms context: only fetch sunrise/sunset, never touch the Leaflet map ──
//
// Bug root cause: the old shared showPosition() called initLeafletMap() even
// when the alarms menu was open and #map-canvas was hidden (0×0). Leaflet
// threw on the hidden container, silently aborting the rest of the callback
// before parseSunsetSunriseAPI() could run. Separated now.

function fetchSunriseSunset() {
    requestPosition(pos => {
        const { latitude, longitude } = pos.coords;

        if (apiLimited && getCookie("sunrise-sunset-api-last-request")) return;

        fetch(`https://api.sunrise-sunset.org/json?lat=${latitude}&lng=${longitude}&formatted=0`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                if (data.status !== "OK") throw new Error("API status: " + data.status);
                const sunriseParsed = utcToGmt(data.results.sunrise, "clock");
                const sunsetParsed  = utcToGmt(data.results.sunset,  "clock");
                document.getElementById("sunrise").innerHTML = "Sunrise: " + sunriseParsed;
                document.getElementById("sunset").innerHTML  = "Sunset: "  + sunsetParsed;
                refreshSunriseSunsetBar(sunriseParsed, sunsetParsed);
                if (apiLimited) setCookie("sunrise-sunset-api-last-request", "1", 1);
            })
            .catch(e => {
                document.getElementById("sunrise").innerHTML = "Sunrise: ERROR";
                document.getElementById("sunset").innerHTML  = "Sunset: ERROR";
                console.warn("Sunrise/sunset API failed:", e);
            });
    });
}

// ── Automaps context: show coordinates + initialize / pan Leaflet map ────────

function getGeoLocationForMap() {
    requestPosition(
        pos => {
            const { latitude, longitude } = pos.coords;
            alarmsGeolocation.innerHTML = `Lat: ${latitude.toFixed(4)} / Lon: ${longitude.toFixed(4)}`;
            initLeafletMap(latitude, longitude);
        },
        err => {
            const msgs = {
                1: "Geolocation denied.",
                2: "Location unavailable.",
                3: "Location timed out.",
            };
            alarmsGeolocation.innerHTML = msgs[err.code] || "Geolocation error.";
            initLeafletMap(DEFAULT_LAT, DEFAULT_LNG);
        }
    );
}

function initLeafletMap(lat, lng) {
    if (!leafletMap) {
        leafletMap = L.map('map-canvas', {
            zoomControl:       false,
            attributionControl: false,
            keyboard:          false,
            dragging:          true,         // pan by drag / touch-drag
            scrollWheelZoom:   false,        // zoom via ±buttons; avoid conflict with radio wheel
            doubleClickZoom:   false,
            tap:               true,         // enable touch on mobile
        }).setView([lat, lng], mapZoom);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
        }).addTo(leafletMap);
    } else {
        leafletMap.setView([lat, lng], mapZoom);
    }

    if (leafletMarker) leafletMarker.remove();
    leafletMarker = L.circleMarker([lat, lng], {
        radius: 6, color: 'rgb(60,240,0)', fillColor: 'rgb(60,240,0)', fillOpacity: 1, weight: 2,
    }).addTo(leafletMap);

    // Always recalculate tiles after showing (container may have been display:none)
    setTimeout(() => leafletMap.invalidateSize(), 100);
}

const mapZoomOut = document.getElementById("map-zoom-out");
const mapZoomIn  = document.getElementById("map-zoom-in");

mapZoomOut.addEventListener("click", function () {
    if (mapZoom > 1)  { mapZoom--; if (leafletMap) leafletMap.setZoom(mapZoom); }
    playAudio('./snd/pipBoyTick.mp3');
});

mapZoomIn.addEventListener("click", function () {
    if (mapZoom < 19) { mapZoom++; if (leafletMap) leafletMap.setZoom(mapZoom); }
    playAudio('./snd/pipBoyTick.mp3');
});

// ─── NOTES / ARCHIVES ────────────────────────────────────────────────────────

const NOTES_KEY = 'pipboy-notes';

function loadNotes() {
    try   { return JSON.parse(localStorage.getItem(NOTES_KEY)) || []; }
    catch { return []; }
}
function saveNotes(notes) { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }

function renderNotes() {
    const notes = loadNotes();
    const list  = document.getElementById('notes-list');
    if (notes.length === 0) {
        list.innerHTML = '<div class="notes-empty">[ NO ENTRIES ]</div>';
        return;
    }
    list.innerHTML = notes.map(n => {
        const preview = escapeHTML(n.text.slice(0, 55)) + (n.text.length > 55 ? '…' : '');
        const date    = new Date(n.created).toLocaleDateString(undefined,
                            { month: 'short', day: 'numeric', year: '2-digit' });
        return `<div class="note-entry" data-id="${n.id}">
            <div class="note-header">
                <span class="note-date">${date}</span>
                <span class="note-delete" data-id="${n.id}">✕</span>
            </div>
            <div class="note-preview">${preview}</div>
        </div>`;
    }).join('');
}

const noteNewBtn    = document.getElementById('note-new');
const noteSaveBtn   = document.getElementById('note-save');
const noteCancelBtn = document.getElementById('note-cancel');
const notesEditor   = document.getElementById('notes-editor');
const notesInput    = document.getElementById('notes-input');
const notesList     = document.getElementById('notes-list');
const noteCharCount = document.getElementById('note-char-count');
const NOTE_MAX_CHARS = 280;

notesInput.addEventListener('input', () => {
    const remaining = NOTE_MAX_CHARS - notesInput.value.length;
    noteCharCount.textContent = remaining;
    noteCharCount.style.color = remaining < 20 ? 'rgb(255,80,0,0.8)' : '';
});

noteNewBtn.addEventListener('click', () => {
    notesEditor.style.display = 'flex';
    noteNewBtn.style.display  = 'none';
    notesInput.value = '';
    noteCharCount.textContent = NOTE_MAX_CHARS;
    noteCharCount.style.color = '';
    notesInput.focus();
    playAudio('./snd/pipBoyTick.mp3');
});

noteSaveBtn.addEventListener('click', () => {
    const text = notesInput.value.trim();
    if (text) {
        const notes = loadNotes();
        notes.unshift({ id: Date.now(), text, created: new Date().toISOString() });
        saveNotes(notes);
        renderNotes();
    }
    notesEditor.style.display = 'none';
    noteNewBtn.style.display  = 'inline-block';
    playAudio('./snd/pipBoyTick.mp3');
});

noteCancelBtn.addEventListener('click', () => {
    notesEditor.style.display = 'none';
    noteNewBtn.style.display  = 'inline-block';
    playAudio('./snd/pipBoyTick.mp3');
});

notesList.addEventListener('click', e => {
    if (!e.target.classList.contains('note-delete')) return;
    saveNotes(loadNotes().filter(n => n.id !== parseInt(e.target.dataset.id)));
    renderNotes();
    playAudio('./snd/pipBoyTick.mp3');
});

// ─── UTILITY FUNCTIONS ───────────────────────────────────────────────────────

function escapeHTML(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Converts a UTC ISO date string to a local time component
function utcToGmt(utcDate, mode) {
    const gmtTime = new Date(utcDate).toString();
    if (mode === "date")      return gmtTime.slice(0, 15);
    if (mode === "clock")     return gmtTime.slice(16, 24);
    if (mode === "dateClock") return gmtTime;
}

// Percentage of the day that HH:MM:SS represents (0–100)
function clockToDayPercent(clock) {
    const [h, m, s] = clock.split(":").map(Number);
    return parseInt(((h * 3600 + m * 60 + s) * 100) / 86400);
}

function widthToPercent(elementWidth, containerWidth) {
    return parseInt(elementWidth) * 100 / parseInt(containerWidth);
}

// Arduino-style range remap
function arduinoMap(value, inMin, inMax, outMin, outMax) {
    return (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
}

// ─── ALARM CLASS ─────────────────────────────────────────────────────────────

class Alarma {
    constructor(hora) {
        this.hora       = hora;
        this.alarmSound = new Audio('./snd/alarm.ogg');
        this.alarmSound.loop = true;
        this.triggered  = false;
    }
    checkAlarm() {
        const now = new Date().toTimeString().slice(0, 8);
        if (now === this.hora && !this.triggered) {
            this.triggered = true;
            this.alarmSound.play().catch(e => console.warn("Alarm audio blocked:", e));
            alarmNeon.style.display = "inline";
            console.log("ALARMA INICIADA :D!");
        } else if (now !== this.hora) {
            this.triggered = false;
        }
    }
    stopAlarm() {
        this.alarmSound.pause();
        this.alarmSound.currentTime = 0;
        this.triggered = false;
        alarmNeon.style.display = "none";
        console.log("ALARMA APAGADA :D!");
    }
    getTimeSet() { return this.hora; }
}

// ─── SCREEN FX ───────────────────────────────────────────────────────────────

function screenDefocus(min, max) {
    document.getElementById("pip-screen").style.filter =
        `blur(${arduinoMap(Math.random(), 0, 1, min, max)}px)`;
}
function screenDebright(min, max) {
    document.getElementById("pip-screen").style.opacity =
        arduinoMap(Math.random(), 0, 1, min, max);
}

setInterval(function () {
    const t = Math.random() * 500;
    setTimeout(() => screenDefocus(0.3, 0.5),  t * 0.15);
    setTimeout(() => screenDebright(0.9, 1.0), t * 0.5);
}, 250);

// ─── MAIN TICK (1 Hz) ────────────────────────────────────────────────────────

setInterval(function () {
    refreshMainClock();
    if (alarmOn && alarm1) alarm1.checkAlarm();
    if (currentMenu === "button-alarms") refreshAlarmsMenuClock();
}, 1000);

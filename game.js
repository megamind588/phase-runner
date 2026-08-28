const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const WIDTH = canvas.width || 800;
const HEIGHT = canvas.height || 600;


let lastTime = performance.now();
const FPS = 60;
const FRAME_TIME = 1000 / FPS;

/* ================= CRAZYGAMES SDK ================= */
let crazyGamesReady = false;
let crazyGamesInitPromise = null;
let crazyGamesInitFailed = false;
let gameStorage = window.localStorage;
let adInProgress = false;
let adRewardPending = false;
let adStatusMessage = "";
let adStatusTimer = 0;

function safeCrazyCall(fn) {
  if (!crazyGamesReady || !window.CrazyGames || !window.CrazyGames.SDK) return;
  try { fn(window.CrazyGames.SDK); } catch (err) {
    console.warn("CrazyGames SDK call failed:", err);
  }
}

async function initCrazyGames() {
  if (crazyGamesInitPromise) return crazyGamesInitPromise;

  crazyGamesInitPromise = (async () => {
    try {
      if (!window.CrazyGames || !window.CrazyGames.SDK) {
        return false;
      }

      await window.CrazyGames.SDK.init();
      crazyGamesReady = true;

      // CrazyGames Data has the same basic API as localStorage.
      // Keep localStorage as a safe fallback outside CrazyGames.
      if (window.CrazyGames.SDK.data) {
        gameStorage = window.CrazyGames.SDK.data;
        migrateLocalProgressToCrazyData();
        loadProgressFromStorage();
      }

      safeCrazyCall(sdk => sdk.game.loadingStop());
      return true;
    } catch (err) {
      crazyGamesInitFailed = true;
      console.warn("CrazyGames SDK unavailable; using local storage:", err);
      return false;
    }
  })();

  return crazyGamesInitPromise;
}

function loadProgressFromStorage() {
  try {
    const storedInventory = getStoredValue("inventory");
    if (storedInventory) {
      const parsed = JSON.parse(storedInventory);
      if (parsed && typeof parsed === "object") {
        inventory = { ...inventory, ...parsed };
        inventory.magnets = Number.isFinite(Number(inventory.magnets)) ? Number(inventory.magnets) : 0;
        inventory.shields = Number.isFinite(Number(inventory.shields)) ? Number(inventory.shields) : 0;
        inventory.ghosts = Number.isFinite(Number(inventory.ghosts)) ? Number(inventory.ghosts) : 0;
      }
    }

    const storedCoins = parseInt(getStoredValue("totalCoins"), 10);
    const storedBest = parseInt(getStoredValue("bestScore"), 10);
    const storedTheme = parseInt(getStoredValue("selectedTheme"), 10);

    if (Number.isFinite(storedCoins)) totalCoins = Math.max(0, storedCoins);
    if (Number.isFinite(storedBest)) bestScore = Math.max(0, storedBest);
    if (Number.isFinite(storedTheme) && THEMES[storedTheme]) {
      activeThemeIndex = storedTheme;
      PHASE_A_COLOR = THEMES[activeThemeIndex].a;
      PHASE_B_COLOR = THEMES[activeThemeIndex].b;
    }
  } catch (err) {
    console.warn("Could not load CrazyGames progress:", err);
  }
}

function migrateLocalProgressToCrazyData() {
  if (!window.CrazyGames || !window.CrazyGames.SDK || !window.CrazyGames.SDK.data) return;
  const data = window.CrazyGames.SDK.data;
  const keys = ["totalCoins", "bestScore", "inventory", "selectedTheme"];

  try {
    keys.forEach(key => {
      const localValue = window.localStorage.getItem(key);
      const dataValue = data.getItem(key);
      if (dataValue === null && localValue !== null) {
        data.setItem(key, localValue);
      }
    });
  } catch (err) {
    console.warn("Could not migrate progress to CrazyGames Data:", err);
  }
}

function saveKey(key, value) {
  try {
    gameStorage.setItem(key, String(value));
  } catch (err) {
    try { window.localStorage.setItem(key, String(value)); } catch (_) {}
  }
}

function getStoredValue(key) {
  try {
    const value = gameStorage.getItem(key);
    if (value !== null) return value;
  } catch (_) {}
  try { return window.localStorage.getItem(key); } catch (_) { return null; }
}

function stopCrazyGameplay() {
  safeCrazyCall(sdk => sdk.game.gameplayStop());
}

function startCrazyGameplay() {
  safeCrazyCall(sdk => sdk.game.gameplayStart());
}

function muteGameForAd() {
  bgMusic.pause();
  if (audioCtx && audioCtx.state === "running") {
    try { audioCtx.suspend(); } catch (_) {}
  }
}

function restoreGameAudioAfterAd() {
  if (audioCtx && audioCtx.state === "suspended" && isSoundOn) {
    try { audioCtx.resume(); } catch (_) {}
  }

  // Never allow background music to play during active gameplay.
  if (currentScene === SCENES.GAME && !isPaused) {
    bgMusic.pause();
    bgMusic.currentTime = 0;
    return;
  }

  updateBackgroundMusic();
}

function showAdStatus(message) {
  adStatusMessage = message;
  adStatusTimer = 180;
}

function requestCrazyRewardedAd(onReward) {
  if (adInProgress) return;

  // Outside CrazyGames (or before SDK initialization), do not grant a fake reward.
  if (!crazyGamesReady || !window.CrazyGames || !window.CrazyGames.SDK || !window.CrazyGames.SDK.ad) {
    console.info("Rewarded ads are unavailable in this environment.");
    showAdStatus("ADS ARE CURRENTLY UNAVAILABLE");
    return;
  }

  adInProgress = true;
  adRewardPending = false;
  const wasGame = currentScene === SCENES.GAME;
  const wasPaused = isPaused;

  if (wasGame && !wasPaused) {
    isPaused = true;
    stopCrazyGameplay();
  }
  muteGameForAd();

  const finish = (reward) => {
    adInProgress = false;
    adRewardPending = false;
    restoreGameAudioAfterAd();

    if (reward && typeof onReward === "function") {
      try { onReward(); } catch (err) { console.error("Reward callback failed:", err); }
    }

    if (wasGame && !wasPaused && currentScene === SCENES.GAME && !isDead) {
      isPaused = false;
      startCrazyGameplay();
    }
  };

  try {
    window.CrazyGames.SDK.ad.requestAd("rewarded", {
      adStarted: () => {
        muteGameForAd();
      },
      adError: (error) => {
        console.warn("Rewarded ad failed/unfilled:", error);
        const code = error && error.code ? error.code : "";
        if (code === "adsDisabledBasicLaunch") showAdStatus("ADS ARE NOT ENABLED YET");
        else if (code === "adblock") showAdStatus("PLEASE DISABLE AD BLOCKING FOR REWARDS");
        else showAdStatus("NO AD AVAILABLE — TRY AGAIN LATER");
        finish(false);
      },
      adFinished: () => {
        finish(true);
      }
    });
  } catch (err) {
    console.warn("Rewarded ad request failed:", err);
    finish(false);
  }
}

function requestCrazyMidgameAd() {
  if (adInProgress || !crazyGamesReady || !window.CrazyGames?.SDK?.ad) return;

  adInProgress = true;
  stopCrazyGameplay();
  muteGameForAd();

  const finish = () => {
    adInProgress = false;
    restoreGameAudioAfterAd();
    if (currentScene === SCENES.GAMEOVER && !isDead) startCrazyGameplay();
  };

  try {
    window.CrazyGames.SDK.ad.requestAd("midgame", {
      adStarted: () => muteGameForAd(),
      adError: (error) => { console.warn("Midgame ad failed/unfilled:", error); finish(); },
      adFinished: finish
    });
  } catch (err) {
    console.warn("Midgame ad request failed:", err);
    finish();
  }
}


/* ================= 1. CONFIG & THEMES ================= */
let inventory = JSON.parse(getStoredValue("inventory")) || {
    magnets: 0,
    shields: 0,
    ghosts : 0
};

if (inventory.ghosts === undefined || isNaN(inventory.ghosts)){
  inventory.ghosts = 0;
}

// Pricing
const COSTS = { magnet: 30, shield: 20, ghost: 50 };

const THEMES = [
  { 
    name: "Neon Classic",
    a: "#00f6ff",
    b: "#ff2dfd",
    cost: 0,
    owned: true
  },
  { 
    name: "Sci-Fi", 
    a: "#bd00ff",
    b: "#4BBEF3",
    cost: 50,
    owned: false
  },
  { 
    name: "Creamy",
    a: "#76FFB4",
    b: "#4A154B",
    cost: 100,
    owned: false
  },
  { 
    name: "Greenery",
    a: "#2b6c13",
    b: "#006C4B",
    cost: 200,
    owned: false 
  }
  
];

let activeThemeIndex = parseInt(getStoredValue("selectedTheme")) || 0;
let PHASE_A_COLOR = THEMES[activeThemeIndex].a;
let PHASE_B_COLOR = THEMES[activeThemeIndex].b;

const DEATH_COLOR = "#ff2d2d";
const SHIELD_COLOR = "#ffffff";
const DOUBLE_COLOR = "#FFD700";
const COIN_COLOR = "#FFD700";

const SCENES = {
  START: "start",
  INSTRUCTIONS: "instructions",
  GAME: "game",
  GAMEOVER: "gameover",
  SHOP: "shop"
};

/* ================= 2. GAME STATE ================= */
// Start on the Home screen. Instructions are shown only the first time the player starts a run.
let currentScene = SCENES.START;
let instructionsShown = false;
let score = 0;
let totalCoins = parseInt(getStoredValue("totalCoins")) || 0;
let bestScore = parseInt(getStoredValue("bestScore")) || 0;
let isDead = false;
let isHolding = false;
let deathFlashAlpha = 0;
let titleX = -400;
let titleTargetX = WIDTH / 2;
let titleSpeed = 18;
let instructionTimer = 0;
let instructionReady = false;
let shakeIntensity = 0;
let isSettingsOpen = false;
let isAdcardOpen = false;
let isShopOpen = false;
let isSoundOn = true;
let audioCtx = null;
function initAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

let isMusicOn = true;
const bgMusic = new Audio("bgmusic.mp3");
bgMusic.loop = true; 


let sessionCoins = 0;
let isPaused = false;
// Objects
let walls = [];
let powerUps = [];
let coins = [];
let particles = [];

// Power-up States
let hasShield = false;
let isInvincible = false;
let isDoubleScore = false;
let doubleScoreTimer = 0;
let isMagnetActive = false;
let magnetTimer = 0;
const MAGNET_COLOR = "#00ffcc";

let isGhostActive = false;
let ghostTimer = 0;
const GHOST_DURATION = 600;

let startScreenAngle = 0;
let menuPlayerPhase = "A";

// Movement/Spawn Settings
let spawnTimer = 0;
let spawnInterval = 90;
let wallSpeed = 3.5;
const WALL_WIDTH = 50;
const WALL_HEIGHT = 220;



//Background 
// Dynamic City Skyline Background Layers
let backBuildings = [];
let frontBuildings = [];

function initCityBackground() {
  backBuildings = [];
  frontBuildings = [];

  // 1. Far Skyline (Darker, taller, moves slower)
  let currentX = 0;
  while (currentX < WIDTH + 200) {
    let bWidth = Math.random() * 40 + 30;
    let bHeight = Math.random() * (HEIGHT * 0.55) + (HEIGHT * 0.5);
    backBuildings.push({
      x: currentX,
      width: bWidth,
      height: bHeight,
      y: HEIGHT - bHeight
    });
    currentX += bWidth + (Math.random() * 10);
  }

  // 2. Near Skyline (Brighter, wider, moves faster)
  currentX = 0;
  while (currentX < WIDTH + 200) {
    let bWidth = Math.random() * 50 + 40;
    let bHeight = Math.random() * (HEIGHT * 0.45) + (HEIGHT * 0.35);
    
    // Generate window grid layout for front buildings
    let windows = [];
    let rows = Math.floor(bHeight / 18);
    let cols = Math.floor(bWidth / 14);
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        if (Math.random() > 0.35) { // 65% chance of lit window
          windows.push({ row: r, col: c });
        }
      }
    }

    frontBuildings.push({
      x: currentX,
      width: bWidth,
      height: bHeight,
      y: HEIGHT - bHeight,
      windows: windows
    });
    currentX += bWidth + (Math.random() * 15);
  }
}


initCityBackground();


/* ================= 3. PLAYER OBJECT ================= */
const player = {
  x: WIDTH * 0.25,
  y: HEIGHT / 2,
  size: 40,
  velocityY: 0,
  gravity: 0.2,
  lift: -0.4,
  dampingUp: 0.88,
  dampingDown: 0.98,
  phase: "A",
  borderRadius : 8
};

/* ================= 4. INPUT HANDLING (FIXED) ================= */
const JUMP_KEYS = ["Space", "KeyW", "ArrowUp"];

document.addEventListener("mousedown", handleInputStart);
document.addEventListener("mouseup", handleInputEnd);
document.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });

document.addEventListener("touchstart", (e) => { 
  if (e.cancelable) e.preventDefault(); 
  handleInputStart(e); 
}, { passive: false });

document.addEventListener("touchend", handleInputEnd);

// Keyboard listeners: Prevents page scroll, key repeat spam & velocity crashes
document.addEventListener("keydown", (e) => {
  if (JUMP_KEYS.includes(e.code)) {
    e.preventDefault(); 
    if (!e.repeat) handleInputStart(e);
  }
});

document.addEventListener("keyup", (e) => {
  if (JUMP_KEYS.includes(e.code)) {
    e.preventDefault();
    handleInputEnd();
  }
});

function getMousePos(e) {
  if (!e || (!e.clientX && !e.touches && !e.changedTouches)) return null;
  
  const rect = canvas.getBoundingClientRect();
  const touchObj = e.touches ? e.touches[0] : (e.changedTouches ? e.changedTouches[0] : null);
  const clientX = touchObj ? touchObj.clientX : e.clientX;
  const clientY = touchObj ? touchObj.clientY : e.clientY;
  
  // Scales coordinates properly if browser resizes canvas
  const scaleX = WIDTH / rect.width;
  const scaleY = HEIGHT / rect.height;

  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY
  };
}

function handleInputStart(e) {
  const pos = getMousePos(e);

  // Safe UI check: Only run menu buttons when input has mouse/touch screen position
  if (pos) {
    if (isAdcardOpen) {
      const adcardY = HEIGHT * 0.3;
      if (isInside(pos.x, pos.y, {x: WIDTH * 0.15, y: adcardY + 170, width: 250, height: 45})) {
        playClickSound();
        requestCrazyRewardedAd(() => {
          totalCoins += 10;
          save();
          isAdcardOpen = false;
        });
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH * 0.825, y: adcardY + 6, width: 40, height: 40})) {
        isAdcardOpen = false;
        playClickSound();
        return;
      }
      return;
    }

    if (isShopOpen) {
      const box = { x: WIDTH * 0.05, y: HEIGHT * 0.08, width: WIDTH * 0.9, height: HEIGHT * 0.84 };
      if (isInside(pos.x, pos.y, { x: box.x + 15, y: box.y + 15, width: 75, height: 35 })) {
        isShopOpen = false;
        playClickSound();
        return;
      }
      if (isInside(pos.x, pos.y, { x: box.x + 120, y: box.y + 175, width: 70, height: 28 })) {
        buyItem("magnets", 30);
        playClickSound();
        return;
      }
      if (isInside(pos.x, pos.y, { x: box.x + 25, y: box.y + 175, width: 70, height: 28 })) {
        buyItem("shields", 20);
        playClickSound();
        return;
      }
      if (isInside(pos.x, pos.y, { x: box.x + 215, y: box.y + 175, width: 70, height: 28 })) {
        buyItem("ghosts", 50);
        playClickSound();
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH * 0.15, y: box.y + 450, width: 250, height: 45})) {
        playClickSound();
        requestCrazyRewardedAd(() => {
          totalCoins += 10;
          save();
          isShopOpen = false;
        });
        return;
      }
      
      
    const cols = 2;
    const themeWidth = (box.width - 50) / cols;
    const cardHeight = 45;
    const rowGap = 55;
    
    THEMES.forEach((t, i) => {
      let col = i % cols;
      let row = Math.floor(i / cols);
      
      let cardX = box.x + 15 + col * (themeWidth + 20);
      let cardY = box.y + 240 + row * (cardHeight + rowGap);
      let btnY = cardY + cardHeight + 6; 

        if (isInside(pos.x, pos.y, { x: cardX + 5, y: btnY, width: themeWidth - 10, height: 28 })) {
          playClickSound();
            if (t.owned) {
                activeThemeIndex = i;
                applyTheme(i);
                save();
                currentScene = SCENES.START;
                isShopOpen = false;
                updateBackgroundMusic();
                return;
            } else if (totalCoins >= t.cost) {
                totalCoins -= t.cost;
                t.owned = true;
                applyTheme();
                save();
            } else {
                isAdcardOpen = true ;
            }
        }
    });
    
    return;
}

    if (currentScene === SCENES.GAME && !isPaused) {
      if (isInside(pos.x, pos.y, { x: 15, y: 15, width: 40, height: 40 })) {
        isPaused = true;
        stopCrazyGameplay();
        playCoinSound();
        updateBackgroundMusic();
        return;
      }
    }

    if (isPaused) {
      const boxY = HEIGHT * 0.2;
      if (isInside(pos.x, pos.y, {x: WIDTH/2 - 70, y: boxY + 210, width: 140, height: 45})) {
        isPaused = false;
        startCrazyGameplay();
        playClickSound();
        updateBackgroundMusic();
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH/2 - 70, y: boxY + 270, width: 140, height: 45})) {
        isPaused = false;
        playClickSound();
        currentScene = SCENES.START;
        updateBackgroundMusic();
        return;
      }
      return;
    }

    if (isSettingsOpen) {
      const menuY = HEIGHT * 0.3;
      if (isInside(pos.x, pos.y, {x: WIDTH * 0.575, y: menuY + 50, width: 60, height: 30})) {
        isSoundOn = !isSoundOn;
        playClickSound();
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH * 0.575, y: menuY + 110, width: 60, height: 30})) {
        isMusicOn = !isMusicOn;
        playClickSound();
        updateBackgroundMusic();
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH * 0.15, y: menuY + 170, width: 250, height: 45})) {
        playClickSound();
        requestCrazyRewardedAd(() => {
          totalCoins += 10;
          save();
          isSettingsOpen = false;
        });
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH * 0.825, y: menuY + 6, width: 40, height: 40})) {
        isSettingsOpen = false;
        playClickSound();
        return;
      }
      return;
    }

    if (currentScene === SCENES.START) {
      isPaused = false;
      isDead = false;
      if (isInside(pos.x, pos.y, { x: 10, y: 10, width: 40, height: 40 })) {
        isSettingsOpen = true;
        playClickSound();
        return;
      }
      if (isInside(pos.x, pos.y, { x: WIDTH/2 - 150, y: HEIGHT * 0.70, width: 130, height: 55 })) {
        isShopOpen = true;
        playClickSound();
        return;
      }
      if (isInside(pos.x, pos.y, { x: WIDTH * 0.55, y: HEIGHT * 0.70, width: 130, height: 55 })) {
        playClickSound();
        if (!instructionsShown) {
          setScene(SCENES.INSTRUCTIONS);
        } else {
          setScene(SCENES.GAME);
        }
        return;
      }
    }

    if (currentScene === SCENES.INSTRUCTIONS) {
      instructionsShown = true;
      setScene(SCENES.GAME);
      playClickSound();
      return;
    }

    if (currentScene === SCENES.GAMEOVER) {
      const boxY = HEIGHT * 0.3;
      if (isInside(pos.x, pos.y, {x: WIDTH/2 - 140, y: boxY + 80, width: 140, height: 45})) {
        playClickSound();
        setScene(SCENES.GAME);
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH/2 - 140, y: boxY + 20, width: 140, height: 45})) {
        playClickSound();
        requestCrazyRewardedAd(() => {
          isDead = false;
          currentScene = SCENES.GAME;
          bgMusic.pause();
          bgMusic.currentTime = 0;
          player.y = HEIGHT / 2;
          walls = [];
          coins = [];
          powerUps = [];
          isHolding = false;
          player.phase = "A";
          isPaused = false;
          startCrazyGameplay();
        });
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH * 0.575, y: boxY + 140, width: 140, height: 45})) {
        playClickSound();
        requestCrazyRewardedAd(() => {
          totalCoins += sessionCoins;
          save();
          currentScene = SCENES.START;
          isDead = false;
          sessionCoins = 0;
          updateBackgroundMusic();
        });
        return;
      }
      if (isInside(pos.x, pos.y, {x: WIDTH/2 - 140, y: boxY + 140, width: 140, height: 45})) {
        playClickSound();
        currentScene = SCENES.START;
        isDead = false;
        updateBackgroundMusic();
        return;
      }
    }

    if (currentScene === SCENES.GAME) {
      if (isInside(pos.x, pos.y, { x: 10, y: HEIGHT - 140, width: 60, height: 60 })) {
        playPowerUpSound();
        if (inventory.magnets > 0 && !isMagnetActive) {
          inventory.magnets--;
          isMagnetActive = true;
          magnetTimer = 1500;
          saveKey("inventory", JSON.stringify(inventory));
        }
        return; 
      }
      if (isInside(pos.x, pos.y, { x: 10, y: HEIGHT - 70, width: 60, height: 60 })) {
        playPowerUpSound();
        if (inventory.shields > 0 && !hasShield) {
          inventory.shields--;
          hasShield = true;
          saveKey("inventory", JSON.stringify(inventory));
        }
        return;
      }
      if (isInside(pos.x, pos.y, { x: 10, y: HEIGHT - 210, width: 60, height: 60 })) {
        playPowerUpSound();
        if (inventory.ghosts > 0 && !isGhostActive) {
          inventory.ghosts--;
          isGhostActive = true;
          ghostTimer = GHOST_DURATION;
          player.velocityY = 0;
          wallSpeed = wallSpeed * 5;
          save();
          saveKey("inventory", JSON.stringify(inventory));
        }
        return;
      }
    }
  }

  // Jump trigger (Works smoothly for Mouse, Touch, Spacebar, W, and ArrowUp)
  if (currentScene === SCENES.GAME && !isPaused && !isDead) {
    isHolding = true;
    player.phase = "B";
    playJumpSound();
  }
}

function handleInputEnd() {
  isHolding = false;
  if (currentScene === SCENES.GAME) player.phase = "A";
}




// ONE MASTER BUTTON FUNCTION FOR THE WHOLE GAME
function drawRoundedButton(x, y, width, height, text, strokeColor = "#fff", fillColor = "#111", textColor = "#fff", radius = 10) {
    ctx.save();
    
    // Path for rounded rectangle
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, radius);

    // Fill
    if (fillColor && fillColor !== "transparent") {
        ctx.fillStyle = fillColor;
        ctx.fill();
    }

    // Border
    if (strokeColor) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    // Label Text
    if (text) {
        ctx.fillStyle = textColor;
        ctx.font = "bold 15px Arial";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        
        // Supports multi-line text (like "Magnet\n30🪙")
        let lines = text.split('\n');
        if (lines.length > 1) {
            ctx.fillText(lines[0], x + width / 2, y + height / 2 - 7);
            ctx.fillText(lines[1], x + width / 2, y + height / 2 + 10);
        } else {
            ctx.fillText(text, x + width / 2, y + height / 2);
        }
    }

    ctx.restore();
}


// ======= SOUND EFFECTS======== 

function playClickSound() {
  if (!isSoundOn) return;
  initAudioContext();

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  // Quick frequency sweep down from 800 Hz to 400 Hz
  osc.frequency.setValueAtTime(800, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(400, audioCtx.currentTime + 0.05);

  // Fade volume out quickly over 0.05 seconds
  gain.gain.setValueAtTime(0.5, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.05);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.05);
}

function playJumpSound() {
  if (!isSoundOn) return;
  initAudioContext();

  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "square"; 
  osc.frequency.setValueAtTime(350, audioCtx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(750, audioCtx.currentTime + 0.08);

  gain.gain.setValueAtTime(1.0, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(audioCtx.currentTime + 0.08);
}

function playCoinSound() {
  if (!isSoundOn) return;
  initAudioContext();

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sine";
  
  // Note 1: 987.77 Hz (B5) for 0.06s
  osc.frequency.setValueAtTime(987.77, now);
  // Note 2: Jump up to 1318.51 Hz (E6)
  osc.frequency.setValueAtTime(1318.51, now + 0.06);

  gain.gain.setValueAtTime(0.5, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(now + 0.15);
}

function playPowerUpSound() {
  if (!isSoundOn) return;
  initAudioContext();

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "square"; // Crisp arcade sound
  
  // Arpeggio notes: C5 -> E5 -> G5 -> C6
  osc.frequency.setValueAtTime(523.25, now);
  osc.frequency.setValueAtTime(659.25, now + 0.05);
  osc.frequency.setValueAtTime(783.99, now + 0.10);
  osc.frequency.setValueAtTime(1046.50, now + 0.15);

  gain.gain.setValueAtTime(0.5, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(now + 0.25);
}

function playDeathSound() {
  if (!isSoundOn) return;
  initAudioContext();

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  osc.type = "sawtooth";
  // Pitch drops from 300 Hz down to 40 Hz
  osc.frequency.setValueAtTime(300, now);
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.35);

  gain.gain.setValueAtTime(0.5, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(now + 0.35);
}



//5. logic and updates

function updatePlayer() {
  
  if (isGhostActive) {
        // 1. COUNT DOWN THE TIMER
        ghostTimer--;

        // 2. KEEP PLAYER LOCKED IN THE CENTER
        let targetY = HEIGHT / 2;
        player.y += (targetY - player.y) * 0.1;
        player.velocityY = 0; // Cancel gravity
        
        let upcomingWall = walls.find(w => w.x + w.width > player.x);
        
        if (upcomingWall){
          player.phase = upcomingWall.phase;
          if(upcomingWall.color){
            player.color = upcomingWall.color;
          }
        }

        // 3. TURN OFF WHEN TIMER EXPIRES (So you can use it again later!)
        if (ghostTimer <= 0) {
            isGhostActive = false;
            wallSpeed = wallSpeed / 5;
            spawnInterval = 90;
        }
  }
  
  if(isPaused || isDead)return;
  
  if (isHolding) {
    player.velocityY += player.lift;
    player.velocityY *= player.dampingUp;
  } else {
    player.velocityY += player.gravity;
    player.velocityY *= player.dampingDown;
  }
  player.y += player.velocityY;
  if (player.y < 0) { player.y = 0; player.velocityY = 0; }
  if (player.y + player.size > HEIGHT) triggerDeath();
}
function updateWalls() {
  
  if(isPaused || isDead) return;
  
  spawnTimer++;
  if (spawnTimer >= spawnInterval) {
    // Spawn Wall
    walls.push({
      x: WIDTH,
      y: Math.random() * (HEIGHT - WALL_HEIGHT - 120) + 80,
      width: WALL_WIDTH, height: WALL_HEIGHT,
      phase: Math.random() < 0.5 ? "A" : "B",
      passed: false, inside: false
    });
    // Chance to spawn Coin or Powerup
    if(Math.random() > 0.5) spawnCoin();
    if(Math.random() < 0.20) spawnPowerUp();
    spawnTimer = 0;
  }

  walls.forEach(wall => {
    wall.x -= wallSpeed;
    
    if (isGhostActive) {
            // GHOST MODE: Do NOT run collision checks!
            // Just award score when wall passes the player
          spawnInterval = 45;
          wall.y = HEIGHT * 0.35;
            if (!wall.passed && wall.x + wall.width < player.x) {
                wall.passed = true;
                score += 1;
            }
  
    }else if (isColliding(player, wall)) {
      wall.inside = true;
      if (player.phase !== wall.phase) {
        if (hasShield) { hasShield = false; isInvincible = true; }
        if (!isInvincible) triggerDeath();
      }
    } else if (wall.inside) {
      wall.inside = false; wall.passed = true; isInvincible = false;
      score += isDoubleScore ? 2 : 1;
      if (score % 10 === 0) {
        wallSpeed += 0.3;
        spawnInterval = Math.max(50, spawnInterval - 5);
      }
    }
    if (!wall.passed && wall.x + wall.width < player.x) triggerDeath();
  });
  walls = walls.filter(w => w.x + w.width > 0);
  
}

function activateGhostPower() {
  let currentGhosts = parseInt(inventory.ghosts)|| 0;
    if (currentGhosts > 0 && !isGhostActive) {
        inventory.ghosts = currentGhosts -1;
        isGhostActive = true;
        ghostTimer = GHOST_DURATION;
        player.velocityY = 0; 
        wallSpeed = wallSpeed * 5;
        if (typeof save === "function") save(); // Save updated inventory
    }
}

function spawnCoin() {
  coins.push({ x: WIDTH + 100, y: Math.random() * (HEIGHT-60)+30, size: 20, collected: false, angle: 0 });
}

function updateCoins() {
  
  if(isPaused || isDead)return;
  
  // Handle the timer
  if (isMagnetActive) {
    magnetTimer--;
    if (magnetTimer <= 0) isMagnetActive = false;
  }

  coins.forEach(c => {
    if (isMagnetActive) {
      // Calculate distance between coin and player
      let dx = player.x - c.x;
      let dy = player.y - c.y;
      let distance = Math.sqrt(dx * dx + dy * dy);

      // If coin is within 300 pixels, pull it in!
      if (distance < 300) {
        c.x += (dx / distance) * 10; // Speed of attraction
        c.y += (dy / distance) * 10;
      } else {
        c.x -= wallSpeed;
      }
    } else {
      c.x -= wallSpeed;
    }

    if (!c.collected && isColliding(player, {x: c.x, y: c.y, width: c.size, height: c.size})) {
      c.collected = true;
      playCoinSound();
      sessionCoins += isMagnetActive? 2 :1;
      totalCoins += isMagnetActive ? 2 : 1;
      saveKey("totalCoins", totalCoins);
    }
  });
  coins = coins.filter(c => c.x + c.size > 0 && !c.collected);
}

function spawnPowerUp() {
  const rand = Math.random();
  let type;

  if (rand < 0.4) {
    type = "MAGNET"; // 40%
  } else if (rand < 0.8) {
    type = "DOUBLE"; // 40% (0.4 to 0.8)
  } else {
    type = "SHIELD"; // 20% (0.8 to 1.0)
  }

  powerUps.push({
    x: WIDTH + 100,
    y: Math.random() * (HEIGHT - 100) + 50,
    size: 30,
    type: type,
    collected: false
  });
}

function updatePowerUps() {
  
  if(isPaused || isDead) return;
  
  if (isDoubleScore) {
    doubleScoreTimer--;
    if (doubleScoreTimer <= 0) isDoubleScore = false;
  }
  if (isMagnetActive){
    magnetTimer--;
    if(magnetTimer <=0){
      isMagnetActive = false;
    }
  }
  powerUps.forEach(p => {
    p.x -= wallSpeed;
    if (!p.collected && isColliding(player, {x: p.x, y: p.y, width: p.size, height: p.size})) {
      p.collected = true;
      playPowerUpSound();
      if (p.type === "SHIELD"){ hasShield = true;
      } else if (p.type === "DOUBLE"){
        isDoubleScore = true ;
        doubleScoreTimer = 800;
      } else if (p.type === "MAGNET"){
        isMagnetActive = true ;
        magnetTimer = 1500;
      }
    }
  });
  powerUps = powerUps.filter(p => p.x + p.size > 0 && !p.collected);
}




//.     Shop Logics 
function applyTheme(index) {
  PHASE_A_COLOR = THEMES[index].a;
  PHASE_B_COLOR = THEMES[index].b;
  saveKey("selectedTheme", index);
}

function buyItem(item, cost) {
    if (totalCoins >= cost) { totalCoins -= cost; inventory[item]++; save(); }
    else { isAdcardOpen = true;
    } // Ad placeholder
}

function usePowerUp(type) {
    if (type === "magnet" && inventory.magnets > 0 && !isMagnetActive) {
        inventory.magnets--; isMagnetActive = true; magnetTimer = 1500; save();
    }
    else if (type === "ghost" && inventory.ghosts > 0 && !isGhostActive){
      inventory.ghosts--;
      isGhostActive = true;
      ghostTimer = GHOST_DURATION;
      save();
    }
    else if (type === "shield" && inventory.shields > 0 && !hasShield) {
        inventory.shields--; hasShield = true; save();
    }
}

function save() {
    saveKey("totalCoins", totalCoins);
    saveKey("inventory", JSON.stringify(inventory));
    saveKey("selectedTheme", activeThemeIndex);
}

/* ================= 7. DRAWING ================= */

/* ================= Active Power-Up HUD Display (Grid Wrapped) ================= */
function drawActivePowerUpHUD() {
  if (currentScene !== SCENES.GAME || isDead) return;

  // Gather active HUD items
  const activeHUDs = [];

  if (isMagnetActive) {
    activeHUDs.push({
      icon: "🧲",
      label: "MAGNET",
      color: "#00ffcc",
      ratio: Math.max(0, magnetTimer / 1500)
    });
  }

  if (isDoubleScore) {
    activeHUDs.push({
      icon: "2x",
      label: "DOUBLE",
      color: "#00ffcc",
      ratio: Math.max(0, doubleScoreTimer / 800)
    });
  }

  if (isGhostActive) {
    activeHUDs.push({
      icon: "👻",
      label: "GHOST",
      color: "#00ffcc",
      ratio: Math.max(0, ghostTimer / GHOST_DURATION)
    });
  }

  if (hasShield) {
    activeHUDs.push({
      icon: "🛡️",
      label: "SHIELD",
      color: "#00ffcc",
      ratio: 1.0
    });
  }

  if (activeHUDs.length === 0) return;

  // Card & Grid Measurements
  const cardWidth = 85;
  const cardHeight = 28;
  const gapX = 8;
  const gapY = 6;
  const baseTopY = 80; // Below main score

  ctx.save();

  // Split items into rows (max 2 per row)
  const rows = [];
  for (let i = 0; i < activeHUDs.length; i += 2) {
    rows.push(activeHUDs.slice(i, i + 2));
  }

  // Draw row by row
  rows.forEach((row, rowIndex) => {
    const rowTotalWidth = row.length * cardWidth + (row.length - 1) * gapX;
    let startX = (WIDTH - rowTotalWidth) / 2;
    const currentY = baseTopY + rowIndex * (cardHeight + gapY);

    row.forEach(hud => {
      // 1. Draw Background Frame
      ctx.fillStyle = "rgba(18, 18, 22, 0.9)";
      ctx.strokeStyle = hud.color;
      ctx.lineWidth = 1.5;

      ctx.beginPath();
      ctx.roundRect(startX, currentY, cardWidth, cardHeight, 6);
      ctx.fill();
      ctx.stroke();

      // 2. Draw Icon & Label Text
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 11px Arial";
      ctx.textAlign = "left";
      ctx.fillText(hud.icon, startX + 5, currentY + 16);

      ctx.fillStyle = hud.color;
      ctx.font = "bold 9px Courier New";
      ctx.fillText(hud.label, startX + 23, currentY + 12);

      // 3. Draw Timer Progress Bar
      const barX = startX + 23;
      const barY = currentY + 17;
      const maxBarWidth = cardWidth - 28;
      const barHeight = 4;

      // Track Background
      ctx.fillStyle = "#333333";
      ctx.beginPath();
      ctx.roundRect(barX, barY, maxBarWidth, barHeight, 2);
      ctx.fill();

      // Shrinking Timer Fill
      const currentBarWidth = maxBarWidth * hud.ratio;
      if (currentBarWidth > 0) {
        ctx.fillStyle = hud.color;
        ctx.beginPath();
        ctx.roundRect(barX, barY, currentBarWidth, barHeight, 2);
        ctx.fill();
      }

      startX += cardWidth + gapX;
    });
  });

  ctx.restore();
}

function drawPlayer() {
  const p = player;

  // Determine main body color and inverted next-phase color
  let bodyColor = isDead ? DEATH_COLOR : (p.phase === "A" ? PHASE_A_COLOR : PHASE_B_COLOR);
  let nextPhaseColor = isDead ? "#ff8888" : (p.phase === "A" ? PHASE_B_COLOR : PHASE_A_COLOR);

  ctx.save();

  // --- 1. Draw Player Body (Rounded Square with Next Phase Outline) ---
  
  ctx.fillStyle = bodyColor;
  
  ctx.beginPath();
  ctx.roundRect(p.x, p.y, p.size, p.size, p.borderRadius || 8);
  ctx.fill();
  
  // Outline the body with the next phase color
  ctx.strokeStyle = nextPhaseColor;
  ctx.lineWidth = 3;
  ctx.stroke();

  // --- 2. Draw Facial Features ---
  if (!isDead) {
    const eyeSize = 6;
    const eyeY = p.y + p.size * 0.35;
    const eyeXOffset = p.x + p.size * 0.58; 

    // Eye setup: Filled with Next Phase color, outlined in Black
    ctx.fillStyle = nextPhaseColor;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 1.5;

    // Left Eye
    ctx.beginPath();
    ctx.roundRect(eyeXOffset, eyeY, eyeSize, eyeSize, 1);
    ctx.fill();
    ctx.stroke();

    // Right Eye
    ctx.beginPath();
    ctx.roundRect(eyeXOffset + 9, eyeY, eyeSize, eyeSize, 1);
    ctx.fill();
    ctx.stroke();

    // Mouth setup
    const mouthY = p.y + p.size * 0.70;
    const mouthX = p.x + p.size * 0.63;

    if (p.phase === "B") { // FLYING / HOLDING (O-shape)
      const mouthRadius = 3.5;
      ctx.beginPath();
      ctx.arc(mouthX + 5, mouthY, mouthRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else { // FALLING / RELEASED (Straight focused mouth)
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(mouthX, mouthY);
      ctx.lineTo(mouthX + 10, mouthY);
      ctx.stroke();
    }
  } else {
    // 'X' Eyes when dead
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2.5;
    const xSize = 7;
    const xY = p.y + p.size * 0.35;
    const xX = p.x + p.size * 0.58;

    // Left X
    ctx.beginPath();
    ctx.moveTo(xX, xY); ctx.lineTo(xX + xSize, xY + xSize);
    ctx.moveTo(xX + xSize, xY); ctx.lineTo(xX, xY + xSize);
    ctx.stroke();

    // Right X
    ctx.beginPath();
    ctx.moveTo(xX + 10, xY); ctx.lineTo(xX + 10 + xSize, xY + xSize);
    ctx.moveTo(xX + 10 + xSize, xY); ctx.lineTo(xX + 10, xY + xSize);
    ctx.stroke();
  }

  // --- 3. Power-up Overlays ---
  
  // GHOST TRAIL
  if (isGhostActive) {
    
    for (let i = 1; i <= 3; i++) {
        ctx.globalAlpha = 0.2 / i; 
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        ctx.roundRect(p.x - (i * 12), p.y, p.size, p.size, p.borderRadius || 8);
        ctx.fill();
    }
    ctx.globalAlpha = 1.0;
  }

  // MAGNET PULSE
  if (isMagnetActive) {
    ctx.strokeStyle = MAGNET_COLOR; 
    ctx.lineWidth = 2;
    let pulse = Math.sin(magnetTimer * 0.1) * 5; 
    ctx.beginPath();
    ctx.arc(p.x + p.size / 2, p.y + p.size / 2, p.size + 15 + pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = MAGNET_COLOR;
    ctx.fill();
    ctx.globalAlpha = 1.0;
  }
  
  // SHIELD
  if (hasShield) {
    ctx.strokeStyle = "#fff"; 
    ctx.lineWidth = 3;
    ctx.strokeRect(p.x - 5, p.y - 5, p.size + 10, p.size + 10);
  }
  
  // DOUBLE SCORE
  if (isDoubleScore) {
    ctx.strokeStyle = DOUBLE_COLOR; 
    ctx.lineWidth = 2;
    ctx.strokeRect(p.x - 10, p.y - 10, p.size + 20, p.size + 20);
  }

  ctx.restore();
}


function drawCityBackground() {
  // 1. Sky Gradient tinted by Theme Colors
  let skyGradient = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  skyGradient.addColorStop(0, "#05050c");
  skyGradient.addColorStop(0.65, "#0d0f1f");
  skyGradient.addColorStop(1, PHASE_A_COLOR + "33"); // 20% opacity tint at horizon
  ctx.fillStyle = skyGradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  
  let currentBaseSpeed = 3.5;
  if(currentScene === SCENES.GAME){
    currentBaseSpeed = (isPaused || isDead)? 0 : wallSpeed;
  }
  
 
  // 2. Draw & Scroll Far Skyline (Parallax speed: 20% of wallSpeed)
  let backSpeed = isPaused || isDead ? 0 : wallSpeed * 0.2;
  ctx.fillStyle = "#0c0d18";
  
  backBuildings.forEach((b) => {
    b.x -= backSpeed;
    ctx.fillRect(b.x, b.y, b.width, b.height);

    // Wrap around infinitely
    if (b.x + b.width < 0) {
      let rightmost = Math.max(...backBuildings.map(item => item.x + item.width));
      b.x = rightmost + (Math.random() * 10);
      b.height = Math.random() * (HEIGHT * 0.55) + (HEIGHT * 0.5);
      b.y = HEIGHT - b.height;
    }
  });

  // 3. Draw & Scroll Near Skyline (Parallax speed: 50% of wallSpeed)
  let frontSpeed = isPaused || isDead ? 0 : wallSpeed * 0.5;

  frontBuildings.forEach((b) => {
    b.x -= frontSpeed;

    // Building Body Gradient
    let bGrad = ctx.createLinearGradient(b.x, b.y, b.x, HEIGHT);
    bGrad.addColorStop(0, "#141628");
    bGrad.addColorStop(1, "#080912");
    ctx.fillStyle = bGrad;
    ctx.fillRect(b.x, b.y, b.width, b.height);

    // Building Roofline Glow Highlight
    ctx.fillStyle = PHASE_B_COLOR;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(b.x, b.y, b.width, 2);
    ctx.globalAlpha = 1.0;

    // Glowing Windows tinted with Theme Colors
    b.windows.forEach((w) => {
      let winX = b.x + (w.col * 14);
      let winY = b.y + (w.row * 18);
      
      // Alternate window colors between Theme A and Theme B
      ctx.fillStyle = (w.row + w.col) % 2 === 0 ? PHASE_A_COLOR : PHASE_B_COLOR;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(winX, winY, 6, 9);
    });
    ctx.globalAlpha = 1.0;

    // Wrap around infinitely
    if (b.x + b.width < 0) {
      let rightmost = Math.max(...frontBuildings.map(item => item.x + item.width));
      b.x = rightmost + (Math.random() * 15);
      b.height = Math.random() * (HEIGHT * 0.45) + (HEIGHT * 0.35);
      b.y = HEIGHT - b.height;
    }
  });
  
}

/* ================= 7. DRAWING (Updated drawWalls) ================= */
function drawWalls() {
  walls.forEach(w => {
    // Determine wall color and opposite phase outline color
    let wallColor = w.phase === "A" ? PHASE_A_COLOR : PHASE_B_COLOR;
    let outlineColor = w.phase === "A" ? PHASE_B_COLOR : PHASE_A_COLOR;
    let cornerRadius = 8;
    ctx.save();

    // 1. Fill Wall Body with Phase Color & Glow
    ctx.fillStyle = wallColor;
   
    
    ctx.beginPath();
    ctx.roundRect(w.x, w.y, w.width, w.height, cornerRadius);
    ctx.fill();

    // 2. Draw Opposite Phase Outline
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = 3;
    
    ctx.beginPath();
    ctx.roundRect(w.x, w.y, w.width, w.height, cornerRadius);
    ctx.stroke();

    ctx.restore();
  });
}

function drawCoins() {
  coins.forEach(c => {
    ctx.save();
    ctx.translate(c.x + c.size/2, c.y + c.size/2);
    ctx.rotate(c.angle);
    ctx.font = "20px sans-serif";
    ctx.textBaseline = "top"; 
    ctx.fillText("🪙", -c.size/2, -c.size/2);
    ctx.restore();
  });
}

function drawToggleSwitch(x, y, width, height, isActive) {
    // 1. Draw the pill track
    ctx.fillStyle = isActive ? "#000000" : "#444"; // Teal if ON, Dark Grey if OFF
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, height / 2); // Rounded corners
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2. Calculate knob position (Left if false, Right if true)
    let radius = (height - 6) / 2;
    let knobX = isActive ? (x + width - radius - 3) : (x + radius + 3);
    let knobY = y + height / 2;

    // 3. Draw the knob (The sliding circle)
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(knobX, knobY, radius, 0, Math.PI * 2);
    ctx.fill();
}

function drawPowerUps() {
  // Set alignment so emojis scale and position cleanly from their center
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  powerUps.forEach(p => {
    // 1. Pick the emoji based on power-up type
    let emoji = "❓"; // Fallback default
    if (p.type === "DOUBLE") {
      emoji = "⚡"; // Or "2️⃣"
    } else if (p.type === "SHIELD") {
      emoji = "🛡️";
    } else if (p.type === "MAGNET") {
      emoji = "🧲";
    }

    // 2. Set font size matching your power-up size property
    ctx.font = `${p.size/1.5}px sans-serif`;

    // 3. Calculate center point so collision box (p.x, p.y) stays identical
    const centerX = p.x + p.size / 2;
    const centerY = p.y + p.size / 2;

    // 4. Draw the emoji
    ctx.fillText(emoji, centerX, centerY);
  });
}

function drawShopMenu() {
    // 1. Semi-transparent backdrop
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // 2. Main Store Box Frame
    const box = { x: WIDTH * 0.05, y: HEIGHT * 0.08, width: WIDTH * 0.9, height: HEIGHT * 0.84 };
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, 16);
    ctx.fillStyle = "#121216";
    ctx.fill();
    ctx.strokeStyle = PHASE_A_COLOR;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // 3. Top Header: Back Button & Coin Counter
    drawRoundedButton(box.x + 15, box.y + 15, 75, 35, "Back", "#ff4444", "#2a1111", "#ff4444", 12);
    
    let coinStr = "🪙 " + totalCoins.toString().padStart(4, '0');
    drawRoundedButton(box.x + box.width - 110, box.y + 15, 95, 35, coinStr, "#FFD700", "#222010", "#FFD700", 12);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Store", box.x + box.width / 2, box.y + 70);

    // ================= 4. POWER-UPS SECTION =================
    ctx.font = "bold 16px Arial";
    ctx.textAlign = "left";
    ctx.fillStyle = "#00f6ff";
    ctx.fillText("Powerups", box.x + 20, box.y + 110);

    // --- Magnet Card ---
    drawRoundedButton(box.x + 115, box.y + 125, 80, 45, "Magnet\n30🪙", "#00ffcc", "#112222", "#00ffcc", 8);
    drawRoundedButton(box.x + 120, box.y + 175, 70, 28, "Buy", "#00ffcc", "#00ffcc", "#000", 8);

    // --- Shield Card ---
    drawRoundedButton(box.x + 20, box.y + 125, 80, 45, "Shield\n20🪙", "#00ffcc", "#112222", "#00ffcc", 8);
    drawRoundedButton(box.x + 25, box.y + 175, 70, 28, "Buy", "#00ffcc", "#00ffcc", "#000", 8);
    
    // --- Ghost Card ---
    drawRoundedButton(box.x + 210, box.y + 125, 80, 45, "Ghost\n50🪙", "#00ffcc", "#112222", "#00ffcc", 8);
    drawRoundedButton(box.x + 215, box.y + 175, 70, 28, "Buy", "#00ffcc", "#00ffcc", "#000", 8);

    // --- Inventory Counters (Far Right) ---
    ctx.font = "13px Courier New";
    ctx.fillStyle = "#fff";
    ctx.fillText(inventory.magnets, box.x + 175, box.y + 165);
    ctx.fillText(inventory.shields, box.x + 80 , box.y + 165);
    ctx.fillText(inventory.ghosts, box.x + 270, box.y + 165);

    // ================= 5. THEMES SECTION =================
    ctx.font = "bold 16px Arial";
    ctx.fillStyle = "#ff2dfd";
    ctx.fillText("Themes", box.x + 20, box.y + 230);
    
    const cols = 2;
    const themeWidth = (box.width - 50) / cols;
    const cardHeight = 45;
    const rowGap = 55;
    
    THEMES.forEach((t, i) => {
      let col = i % cols;
      let row = Math.floor(i / cols);
      let cardX = box.x + 15 + col * (themeWidth + 20);
      let cardY = box.y + 240 + row * (cardHeight + rowGap);

        // Card Box displaying Theme Name & Price
        let labelText = t.name + "\n" + (t.cost > 0 ? t.cost + "🪙" : "FREE");
        drawRoundedButton(cardX, cardY, themeWidth, cardHeight, labelText, t.a, "#1a1a24", t.a, 8);

        // Action Button underneath (BUY, EQUIP, or EQUIPPED)
        let btnY = cardY + cardHeight + 6;
        let btnText = "Buy";
        let btnColor = t.a;

        if (t.owned) {
            if (i === activeThemeIndex) {
                btnText = "Equipped";
                btnColor = "#555";
            } else {
                btnText = "Equip";
                btnColor = "#00ffcc";
            }
        }

        drawRoundedButton(cardX + 5, btnY, themeWidth - 10, 28, btnText, btnColor, t.owned && i !== activeThemeIndex ? btnColor : "transparent", t.owned && i !== activeThemeIndex ? "#000" : btnColor, 8);
    });
    
    drawRoundedButton(WIDTH * 0.15, box.y + 450,250,45,"WATCH AD ▶️ = 10","#FFD700","#222010","#FFD700");
    
}

function drawDeathUI() {
    // 1. Fade the background
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // 2. Draw the "Death Box" (The Center Card)
    const box = { x: WIDTH * 0.05, y: HEIGHT * 0.3, width: WIDTH * 0.9, height: HEIGHT * 0.4 };
    
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, 16);
    ctx.fillStyle = "#121216";
    ctx.fill();
    ctx.strokeStyle = PHASE_A_COLOR ;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    
    // 3. Stats Text
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = "bold 30px Arial";
    ctx.fillText("GAME OVER", WIDTH / 2, HEIGHT *0.25);

    ctx.font = "20px Courier New";
    ctx.fillStyle = "#aaa";
    // Formatting numbers with your new 0000 style
    ctx.fillText("SCORE: " + score.toString().padStart(4, '0'), WIDTH * 0.725, box.y + 40);
    ctx.fillText("BEST:  " + bestScore.toString().padStart(4, '0'), WIDTH * 0.725, box.y + 70);
    
    ctx.fillStyle = "#FFD700"; // Gold for coins
    ctx.fillText("Earned:" + sessionCoins.toString().padStart(4, '0'),WIDTH* 0.725,box.y + 100)
    drawRoundedButton(WIDTH/2 - 140, box.y + 20, 140, 45, "REVIVE ▶️", "#00ffcc", "#00332c", "#00ffcc");
    drawRoundedButton(WIDTH/2-140, box.y + 80, 140,45,"Restart","#ffffff","#222");
    drawRoundedButton(WIDTH * 0.575, box.y + 140, 110, 45, "2x 🪙 ▶️ ", "#FFD700", "#222010", "#FFD700");
    drawRoundedButton(WIDTH/2 - 140, box.y + 140, 140, 45, "HOME", "#ff4444", "#2a1111", "#ff4444");

}



/* ================= 8. SYSTEM / UTILS ================= */
function updateBackgroundMusic() {
  // Preserve Phase Runner's original music behavior:
  // - Music plays on Start, Instructions, Shop, Settings and Game Over.
  // - Music is OFF during active gameplay.
  // - Music plays while gameplay is paused.
  // - Ads always override this and mute/pause music.
  const shouldPlayMusic = !adInProgress && isMusicOn && (currentScene !== SCENES.GAME || isPaused);

  if (shouldPlayMusic) {
    if (bgMusic.paused) {
      bgMusic.play().catch(() => {
        // Browser autoplay restrictions are handled by the next user interaction.
      });
    }
  } else if (!bgMusic.paused) {
    bgMusic.pause();
  }
}



function triggerDeath() {
  if (isDead) return;
  isDead = true;
  playDeathSound();
  shakeIntensity = 10;
  isDead = true;
  currentScene = SCENES.GAMEOVER;
  stopCrazyGameplay();
  updateBackgroundMusic();
  if (score > bestScore) {
    bestScore = score;
    saveKey("bestScore", bestScore);
    safeCrazyCall(sdk => sdk.game.happytime());
  }
}

function setScene(s) {
  const previousScene = currentScene;

  if (previousScene === SCENES.GAME && s !== SCENES.GAME) {
    stopCrazyGameplay();
  }

  currentScene = s;

  if (s === SCENES.GAME) {
    isDead = false; score = 0; walls = []; coins = []; powerUps = []; sessionCoins = 0;
    hasShield = false; isDoubleScore = false; wallSpeed = 3.5; spawnInterval = 90;
    isMagnetActive = false;
    magnetTimer = 0;
    player.y = HEIGHT/2; player.velocityY = 0;
    isPaused = false;
    startCrazyGameplay();
  }

  // Keep the original music rules synchronized with every scene transition.
  updateBackgroundMusic();
}

function isColliding(a, b) {
  let bW = b.width || b.size; let bH = b.height || b.size;
  return a.x < b.x + bW && a.x + a.size > b.x && a.y < b.y + bH && a.y + a.size > b.y;
}

function isInside(x, y, btn) {
  return x >= btn.x && x <= btn.x + btn.width && y >= btn.y && y <= btn.y + btn.height;
}



// Start / Instructions Screens
/* ================= 8. SYSTEM / UTILS ================= */
function drawStart() {
    startScreenAngle += 0.025; // Smooth rotation & timer counter

    // Infinite Phase Switcher: Toggles between "A" and "B" every ~1.5 seconds smoothly
    let currentMenuPhase = Math.sin(startScreenAngle * 2) > 0 ? "A" : "B";

    let avatarColor = currentMenuPhase === "A" ? PHASE_A_COLOR : PHASE_B_COLOR;
    let avatarOutline = currentMenuPhase === "A" ? PHASE_B_COLOR : PHASE_A_COLOR;

    ctx.save();
    ctx.translate(WIDTH / 2, HEIGHT * 0.38);

    // 1. Animated Dual-Phase Portal Rings (Behind Larger Player)
    ctx.lineWidth = 4;
    
    // Outer Phase A Ring
    ctx.strokeStyle = PHASE_A_COLOR;
    
    ctx.beginPath();
    ctx.arc(0, 0, 75, startScreenAngle, startScreenAngle + Math.PI * 1.2);
    ctx.stroke();

    // Inner Phase B Ring (Counter-Rotating)
    ctx.strokeStyle = PHASE_B_COLOR;
   
    ctx.beginPath();
    ctx.arc(0, 0, 88, -startScreenAngle, -startScreenAngle + Math.PI * 1.2);
    ctx.stroke();

    // 2. Larger Avatar Player (Size 80x80)
    const pSize = 80;
    const half = pSize / 2;

    ctx.fillStyle = avatarColor;
    
    
    ctx.beginPath();
    ctx.roundRect(-half, -half, pSize, pSize, 14);
    ctx.fill();

    // Sharp Contrast Outline
   
    ctx.strokeStyle = avatarOutline;
    ctx.lineWidth = 4;
    ctx.stroke();

    // 3. Avatar Face Details (Scaled for 80x80 player)
    const eyeSize = 12;
    const eyeY = -half + pSize * 0.32;
    const eyeXOffset = -half + pSize * 0.58;

    // Eyes
    ctx.fillStyle = avatarOutline;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2;

    // Left Eye
    ctx.beginPath();
    ctx.roundRect(eyeXOffset, eyeY, eyeSize, eyeSize, 2);
    ctx.fill();
    ctx.stroke();

    // Right Eye
    ctx.beginPath();
    ctx.roundRect(eyeXOffset + 18, eyeY, eyeSize, eyeSize, 2);
    ctx.fill();
    ctx.stroke();

    // Mouth (Changes according to active phase)
    const mouthY = -half + pSize * 0.70;
    const mouthX = -half + pSize * 0.63;

    if (currentMenuPhase === "B") { // Open O-Mouth
      ctx.beginPath();
      ctx.arc(mouthX + 10, mouthY, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else { // Focused Straight Line
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(mouthX, mouthY);
      ctx.lineTo(mouthX + 20, mouthY);
      ctx.stroke();
    }

    ctx.restore();

    // 4. Start & Store Buttons
    drawRoundedButton(WIDTH * 0.55, HEIGHT * 0.72, 130, 55, "START", "#00ffcc", "#112222", "#00ffcc");
    drawRoundedButton(WIDTH / 2 - 150, HEIGHT * 0.72, 130, 55, "STORE", "#FFD700", "#222010", "#FFD700");

    // 5. Header HUD Icons
    ctx.fillStyle = "#fff";
    ctx.font = "bold 35px Arial";
    ctx.textAlign = "left";
    ctx.fillText("⚙️", 5, 40);

    let displaybestScore = bestScore.toString().padStart(4, '0');
    let displayCoins = totalCoins.toString().padStart(4, '0');

    ctx.font = "bold 20px Courier New";
    ctx.fillText("🪙:" + displayCoins, 270, 60);
    ctx.fillText("🏁:" + displaybestScore, 270, 30);
}
/* ================= 8. INSTRUCTIONS SCENE ================= */
/* ================= 8. INSTRUCTIONS SCENE ================= */
function drawInstructions() {
  ctx.save();

  const marginX = 15;
  const cardW = (WIDTH - marginX * 2 - 10) / 2;
  const cardH = 75;
  const topY = 40;

  // --- ROW 1: Match Phase (Top Left) & Tap/Hold (Top Right) ---
  
  // Card 1: Match Phase (Top Left)
  const c1X = marginX;
  const c1Y = topY;
  ctx.fillStyle = "rgba(0, 240, 255, 0.1)";
  ctx.strokeStyle = PHASE_A_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(c1X, c1Y, cardW, cardH, 8);
  ctx.fill(); ctx.stroke();

  // Player A & Wall A
  ctx.fillStyle = PHASE_A_COLOR;
  ctx.strokeStyle = PHASE_B_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(c1X + 30, c1Y + 25, 20, 20, 4);
  ctx.fill(); ctx.stroke();

  ctx.beginPath();
  ctx.roundRect(c1X + cardW - 40, c1Y + 15, 14, 40, 3);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = "#00ffcc";
  ctx.font = "bold 9.5px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Match Phase", c1X + cardW / 2, c1Y + 56);
  ctx.fillStyle = "#ffffff";
  ctx.font = "8.5px Arial";
  ctx.fillText("Pass Safely", c1X + cardW / 2, c1Y + 67);

  // Card 2: Tap / Hold (Top Right)
  const c2X = c1X + cardW + 10;
  const c2Y = topY;
  ctx.fillStyle = "rgba(255, 0, 128, 0.1)";
  ctx.strokeStyle = PHASE_B_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(c2X, c2Y, cardW, cardH, 8);
  ctx.fill(); ctx.stroke();

  // Player B & Wall B
  ctx.fillStyle = PHASE_B_COLOR;
  ctx.strokeStyle = PHASE_A_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(c2X + 30, c2Y + 25, 20, 20, 4);
  ctx.fill(); ctx.stroke();

  ctx.beginPath();
  ctx.roundRect(c2X + cardW - 40, c2Y + 15, 14, 40, 3);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = "#ff2dfd";
  ctx.font = "bold 9.5px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Tap / Hold", c2X + cardW / 2, c2Y + 56);
  ctx.fillStyle = "#ffffff";
  ctx.font = "8.5px Arial";
  ctx.fillText("Shift Phase", c2X + cardW / 2, c2Y + 67);

  // --- ROW 2: Wrong Phase Die (Middle Left) & Shift In Wall Die (Middle Right) ---
  
  // Card 3: Wrong Phase Die
  const c3Y = c1Y + cardH + 10;
  ctx.fillStyle = "rgba(255, 50, 50, 0.12)";
  ctx.strokeStyle = "#ff4444";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(c1X, c3Y, cardW, cardH, 8);
  ctx.fill(); ctx.stroke();

  // Player A hitting Wall B
  ctx.fillStyle = PHASE_A_COLOR;
  ctx.strokeStyle = PHASE_B_COLOR;
  ctx.beginPath();
  ctx.roundRect(c1X + 15, c3Y + 25, 20, 20, 4);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = PHASE_B_COLOR;
  ctx.strokeStyle = PHASE_A_COLOR;
  ctx.beginPath();
  ctx.roundRect(c1X + 24, c3Y + 15, 14, 40, 3);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = "#ff5555";
  ctx.font = "bold 9.5px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Wrong Phase", c1X + cardW / 1.5, c3Y + 35);
  ctx.fillStyle = "#ffffff";
  ctx.font = "8.5px Arial";
  ctx.fillText("Die 💀", c1X + cardW / 1.5, c3Y + 45);

  // Card 4: Shift In Wall Die
  ctx.fillStyle = "rgba(255, 50, 50, 0.12)";
  ctx.strokeStyle = "#ff4444";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(c2X, c3Y, cardW, cardH, 8);
  ctx.fill(); ctx.stroke();

  // Player shifting inside Wall
  ctx.fillStyle = PHASE_A_COLOR;
  ctx.strokeStyle = PHASE_B_COLOR;
  ctx.beginPath();
  ctx.roundRect(c2X + 24, c3Y + 15, 14, 40, 3);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = PHASE_B_COLOR;
  ctx.strokeStyle = PHASE_A_COLOR;
  ctx.beginPath();
  ctx.roundRect(c2X + 20, c3Y + 25, 20, 20, 4);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = "#ff5555";
  ctx.font = "bold 9.5px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Shift In Wall", c2X + cardW / 1.5, c3Y + 35);
  ctx.fillStyle = "#ffffff";
  ctx.font = "8.5px Arial";
  ctx.fillText("Die 💀", c2X + cardW / 1.5, c3Y + 45);

  // --- ROW 3: Leave Wall Die (Centered Center Card) ---
  const c5Y = c3Y + cardH + 10;
  const c5W = cardW * 1.2;
  const c5X = (WIDTH - c5W) / 2;

  ctx.fillStyle = "rgba(255, 50, 50, 0.12)";
  ctx.strokeStyle = "#ff4444";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(c5X, c5Y, c5W, cardH - 10, 8);
  ctx.fill(); ctx.stroke();

  // Player exiting wall early
  ctx.fillStyle = PHASE_A_COLOR;
  ctx.strokeStyle = PHASE_B_COLOR;
  ctx.beginPath();
  ctx.roundRect(c5X + 20, c5Y + 8, 12, 32, 3);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = PHASE_A_COLOR;
  ctx.strokeStyle = PHASE_B_COLOR;
  ctx.beginPath();
  ctx.roundRect(c5X + 35, c5Y + 38, 16, 16, 3);
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = "#ff5555";
  ctx.font = "bold 10px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Leave Wall", c5X + c5W / 2 + 10, c5Y + 26);
  ctx.fillStyle = "#ffffff";
  ctx.font = "9px Arial";
  ctx.fillText("Die 💀", c5X + c5W / 2 + 10, c5Y + 40);

  // --- ROW 4: POWER UPS TITLE & GRID ---
  const powerY = c5Y + cardH + 12;
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 13px Arial";
  ctx.textAlign = "center";
  ctx.fillText("POWER UPS", WIDTH / 2, powerY);

  const items = [
    { icon: "🧲", name: "MAGNET", color: MAGNET_COLOR },
    { icon: "⚡", name: "DOUBLE", color: DOUBLE_COLOR },
    { icon: "👻", name: "GHOST", color: "#ff2dfd" },
    { icon: "🛡️", name: "SHIELD", color: SHIELD_COLOR }
  ];

  const gridY = powerY + 10;
  const itemW = (WIDTH - marginX * 2 - 10) / 2;
  const itemH = 34;

  items.forEach((item, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const itemX = marginX + col * (itemW + 10);
    const itemY = gridY + row * (itemH + 8);

    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(itemX, itemY, itemW, itemH, 6);
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
    ctx.beginPath();
    ctx.roundRect(itemX + 4, itemY + 4, 26, 26, 4);
    ctx.fill();

    ctx.font = "14px Arial";
    ctx.textAlign = "center";
    ctx.fillText(item.icon, itemX + 17, itemY + 22);

    ctx.fillStyle = item.color;
    ctx.font = "bold 10px Courier New";
    ctx.textAlign = "left";
    ctx.fillText(item.name, itemX + 36, itemY + 21);
  });

  // --- BOTTOM: TAP TO CONTINUE ---
  const pulse = Math.sin(Date.now() * 0.005) * 0.3 + 0.7;
  ctx.fillStyle = `rgba(255, 255, 255, ${pulse})`;
  ctx.font = "bold 15px Arial";
  ctx.textAlign = "center";
  ctx.fillText("TAP TO CONTINUE", WIDTH / 2, HEIGHT - 25);

  ctx.restore();
}

function drawPauseMenu() {
    // 1. Darken the screen
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // 2. The Menu Box
    const box = { x: WIDTH * 0.1, y: HEIGHT * 0.2, width: WIDTH * 0.8, height: HEIGHT * 0.55 };
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.width, box.height, 16);
    ctx.fillStyle = "#121216";
    ctx.fill();
    ctx.strokeStyle = PHASE_A_COLOR ;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // 3. Stats Section
    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.font = "bold 25px Arial";
    ctx.fillText("PAUSED", WIDTH/2, box.y + 40);

    ctx.font = "16px Courier New";
    ctx.fillText("SCORE: " + score.toString().padStart(4, '0'), WIDTH/2, box.y + 80);
    ctx.fillText("EARNED: " + sessionCoins.toString().padStart(4, '0'), WIDTH/2, box.y + 110);
    ctx.fillText("BEST: " + bestScore.toString().padStart(4, '0'), WIDTH/2, box.y + 140);
    
    ctx.fillStyle = "#FFD700";
    ctx.fillText("TOTAL: " + totalCoins.toString().padStart(4, '0'), WIDTH/2, box.y + 170);
    drawRoundedButton(WIDTH/2 - 70, box.y + 210, 140, 45, "CONTINUE", "#00ffcc", "#112222", "#00ffcc");
    drawRoundedButton(WIDTH/2 - 70, box.y + 270, 140, 45, "HOME", "#ff4444", "#2a1111", "#ff4444");
}

function drawAdcard() {
    // 1. Semi-transparent background to "dim" the game
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // 2. The Adcard Box
    const adcardBox = { x: WIDTH * 0.05, y: HEIGHT * 0.3, width: WIDTH * 0.9, height: HEIGHT * 0.4 };
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(adcardBox.x, adcardBox.y, adcardBox.width, adcardBox.height, 16);
    ctx.fillStyle = "#121216";
    ctx.fill();
    ctx.strokeStyle = PHASE_A_COLOR ;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    
    ctx.fillStyle = "#fff";
    ctx.font = "bold 25px Arial";
    ctx.textAlign = "center";
    ctx.fillText("NOT ENOUGH COINS", WIDTH/2, adcardBox.y + 120 );
    
    drawRoundedButton(WIDTH * 0.15, adcardBox.y + 170,250,45,"WATCH AD ▶️ = 10","#FFD700","#222010","#FFD700");
    
    ctx.fillStyle = "#fff";
    ctx.font  = "bold 25px Arial";
    ctx.textAlign = "left";
    ctx.fillText("❌", WIDTH * 0.840, adcardBox.y + 30);
    
}


function drawSettingsMenu() {
    // 1. Semi-transparent background to "dim" the game
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // 2. The Menu Box
    const menuBox = { x: WIDTH * 0.05, y: HEIGHT * 0.3, width: WIDTH * 0.9, height: HEIGHT * 0.4 };
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(menuBox.x, menuBox.y, menuBox.width, menuBox.height, 16);
    ctx.fillStyle = "#121216";
    ctx.fill();
    ctx.strokeStyle = PHASE_A_COLOR ;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    
    
    ctx.fillStyle = "#fff";
    ctx.font = "bold 25px Arial";
    ctx.textAlign = "center";

        // 3. Sound Toggle Button
    ctx.fillStyle = "#fff";
    ctx.font = "bold 25px Arial";
    ctx.textAlign = "left";
    ctx.fillText("SOUND", menuBox.x + 40, menuBox.y + 72);
    
    const soundToggle = {
      x: WIDTH * 0.575,y: menuBox.y + 50,width: 60,height: 30
    };
    
    drawToggleSwitch(soundToggle.x, soundToggle.y, soundToggle.width, soundToggle.height, isSoundOn);
    


    
    drawRoundedButton(WIDTH * 0.15, menuBox.y + 170,250,45,"WATCH AD ▶️ = 10","#FFD700","#222010","#FFD700");
    
    // 5. Musictoggle
    ctx.fillStyle = "#fff";
    ctx.font = "bold 25px Arial";
    ctx.textAlign = "left";
    ctx.fillText("MUSIC", menuBox.x + 40, menuBox.y + 132);
    
    const musicToggle = {
      x: WIDTH * 0.575,y: menuBox.y + 110,width: 60,height: 30
    };
    
    drawToggleSwitch(musicToggle.x, musicToggle.y, musicToggle.width, musicToggle.height, isMusicOn);
    
    ctx.fillStyle = "#fff";
    ctx.font = "bold 25px Arial";
    ctx.textAlign = "left";
    ctx.fillText("❌", WIDTH * 0.840, menuBox.y + 30);
    
}

/* ================= 9. MAIN LOOP ================= */

let frameAccumulator = 0;

function gameLoop(timestamp) {
  requestAnimationFrame(gameLoop);

  if (!timestamp) timestamp = performance.now();
  if (!lastTime || timestamp < lastTime) lastTime = timestamp;

  let deltaTime = timestamp - lastTime;
  lastTime = timestamp;

  // Prevent huge catch-up updates after tab switching/background throttling.
  if (deltaTime > 250) deltaTime = FRAME_TIME;
  frameAccumulator += deltaTime;

  // Fixed 60 Hz simulation step. This keeps gameplay physics consistent on
  // 60/120/144/165 Hz displays while rendering at the browser's refresh rate.
  let safetySteps = 0;
  while (frameAccumulator >= FRAME_TIME && safetySteps < 5) {
    if (currentScene === SCENES.GAME && !isDead && !isPaused && !adInProgress) {
      updatePlayer();
      updateWalls();
      updateCoins();
      updatePowerUps();
    }


    frameAccumulator -= FRAME_TIME;
    safetySteps++;
  }

  ctx.save();

  if (shakeIntensity > 0) {
    let dx = Math.random() * shakeIntensity - shakeIntensity / 2;
    let dy = Math.random() * shakeIntensity - shakeIntensity / 2;
    ctx.translate(dx, dy);
    shakeIntensity *= 0.9;
    if (shakeIntensity < 0.5) shakeIntensity = 0;
  }

  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  drawCityBackground();

  if (currentScene === SCENES.START) drawStart();
  else if (currentScene === SCENES.INSTRUCTIONS) drawInstructions();
  else {
    drawPlayer();
    drawWalls();
    drawCoins();
    drawPowerUps();

    ctx.fillStyle = "#fff";
    ctx.font = "40px Arial";
    ctx.textAlign = "center";
    ctx.fillText(score, WIDTH / 2, 50);

    drawActivePowerUpHUD();

    let displaybestScore = bestScore.toString().padStart(4, '0');
    let displayCoins = totalCoins.toString().padStart(4, '0');

    ctx.fillStyle = "#fff";
    ctx.font = "bold 20px Courier New";
    ctx.textAlign = "left";
    ctx.fillText("🪙:" + displayCoins, 270, 60);
    ctx.fillText("🏁:" + displaybestScore, 270, 30);

    drawRoundedButton(15, 15, 40, 40, "||", "#fff", "#222", "#fff");
    drawRoundedButton(10, HEIGHT - 140, 60, 60, "🧲", "#00ffcc", "#112222", "#00ffcc");
    drawRoundedButton(10, HEIGHT - 70, 60, 60, "🛡️", "#00ffcc", "#112222", "#00ffcc");
    drawRoundedButton(10, HEIGHT - 210, 60, 60, "👻", "#00ffcc", "#112222", "#00ffcc");

    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.fillText(inventory.ghosts, 55, HEIGHT - 160);
    ctx.fillText(inventory.magnets, 55, HEIGHT - 90);
    ctx.fillText(inventory.shields, 55, HEIGHT - 20);

    if (isPaused) drawPauseMenu();
    if (isDead) drawDeathUI();

    // Particles are visual-only, so they are updated once per rendered frame.
    if (currentScene === SCENES.GAME && !isDead && !isPaused && !adInProgress && Math.random() > 0.4) {
      particles.push({
        x: player.x,
        y: player.y + player.size / 2,
        size: Math.random() * 6 + 2,
        vx: -Math.random() * 2 - 2,
        vy: (Math.random() - 0.5) * 2,
        life: 1.0,
        color: player.phase === "A" ? PHASE_A_COLOR : PHASE_B_COLOR
      });
    }

    particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.02;
      p.size *= 0.96;
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    });
    ctx.globalAlpha = 1.0;
    particles = particles.filter(p => p.life > 0);
  }

  if (isSettingsOpen) drawSettingsMenu();
  if (isShopOpen) drawShopMenu();
  if (isAdcardOpen) drawAdcard();

  if (adStatusTimer > 0) {
    adStatusTimer--;
    ctx.save();
    ctx.fillStyle = "rgba(10, 10, 18, 0.92)";
    ctx.strokeStyle = PHASE_A_COLOR;
    ctx.lineWidth = 2;
    const toastW = WIDTH * 0.86;
    const toastH = 46;
    const toastX = (WIDTH - toastW) / 2;
    const toastY = HEIGHT * 0.08;
    ctx.beginPath();
    ctx.roundRect(toastX, toastY, toastW, toastH, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 11px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(adStatusMessage, WIDTH / 2, toastY + toastH / 2);
    ctx.restore();
  }

  ctx.restore();
}

// Start SDK initialization and loading tracking before the first frame.
try {
  if (window.CrazyGames?.SDK?.game?.loadingStart) {
    window.CrazyGames.SDK.game.loadingStart();
  }
} catch (_) {}
initCrazyGames();

// Start loop safely
requestAnimationFrame(gameLoop);
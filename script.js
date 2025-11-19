const canvas = document.getElementById('game-canvas');
// We will initialize context later based on renderer choice
let ctx = null; 

// WebGPU Renderer Instance
let webgpuRenderer = null;
let useWebGPU = false;

// Game Constants
const GRAVITY = 0.25;
const FLAP = -4.5;
const SPAWN_RATE = 90; // Frames between pipes
const PIPE_WIDTH = 50;
const PIPE_SPACING = 200; // Horizontal space between pipes (not used directly in this logic but good for reference)
const PIPE_GAP = 100; // Vertical gap between top and bottom pipes
const BIRD_SIZE = 24;

// Game State
let frames = 0;
let score = 0;
let bestScore = localStorage.getItem('flappy_best_score') || 0;
let gameState = 'START'; // START, PLAYING, GAMEOVER

// DOM Elements
const startScreen = document.getElementById('start-screen');
const gameOverScreen = document.getElementById('game-over-screen');
const scoreDisplay = document.getElementById('score-display');
const currentScoreEl = document.getElementById('current-score');
const bestScoreEl = document.getElementById('best-score');
const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');

// Initialize Renderer
async function initRenderer() {
    if (navigator.gpu) {
        try {
            webgpuRenderer = new WebGPURenderer(canvas);
            const success = await webgpuRenderer.init();
            if (success) {
                useWebGPU = true;
                console.log("Using WebGPU Renderer");
                return;
            }
        } catch (e) {
            console.error("WebGPU init failed:", e);
        }
    }
    
    // Fallback to 2D
    console.log("Using Canvas 2D Renderer");
    ctx = canvas.getContext('2d');
}

// Assets (Drawing simple shapes instead of images for "plain html/js" requirement, but could be swapped)
const bird = {
    x: 50,
    y: 150,
    w: BIRD_SIZE,
    h: BIRD_SIZE,
    radius: BIRD_SIZE / 2,
    speed: 0,
    rotation: 0,
    
    draw: function() {
        if (useWebGPU) return; // Handled by renderer
        
        ctx.save();
        ctx.translate(this.x, this.y);
        // Rotate bird based on speed
        this.rotation = Math.min(Math.PI / 4, Math.max(-Math.PI / 4, (this.speed * 0.1)));
        ctx.rotate(this.rotation);
        
        // Body
        ctx.fillStyle = '#FFD700';
        ctx.beginPath();
        ctx.arc(0, 0, this.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Eye
        ctx.fillStyle = '#FFF';
        ctx.beginPath();
        ctx.arc(6, -6, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(8, -6, 2, 0, Math.PI * 2);
        ctx.fill();
        
        // Beak
        ctx.fillStyle = '#FFA500';
        ctx.beginPath();
        ctx.moveTo(6, 2);
        ctx.lineTo(16, 6);
        ctx.lineTo(6, 10);
        ctx.fill();
        ctx.stroke();
        
        // Wing
        ctx.fillStyle = '#F0E68C';
        ctx.beginPath();
        ctx.ellipse(-4, 4, 8, 5, 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.restore();
    },
    
    update: function() {
        this.speed += GRAVITY;
        this.y += this.speed;
        
        // Update rotation for WebGPU usage
        this.rotation = Math.min(Math.PI / 4, Math.max(-Math.PI / 4, (this.speed * 0.1)));

        // Floor collision
        if (this.y + this.radius >= canvas.height - 20) { // -20 for ground
            this.y = canvas.height - 20 - this.radius;
            gameOver();
        }
        
        // Ceiling collision (optional, but good practice)
        if (this.y - this.radius <= 0) {
            this.y = this.radius;
            this.speed = 0;
        }
    },
    
    flap: function() {
        this.speed = FLAP;
        if (useWebGPU) {
            webgpuRenderer.addParticle(this.x - 10, this.y + 10);
            webgpuRenderer.addParticle(this.x - 15, this.y + 5);
        }
    },
    
    reset: function() {
        this.y = 150;
        this.speed = 0;
        this.rotation = 0;
    }
};

const pipes = {
    items: [],
    
    draw: function() {
        if (useWebGPU) return;

        for (let i = 0; i < this.items.length; i++) {
            let p = this.items[i];
            
            ctx.fillStyle = '#73BF2E';
            ctx.strokeStyle = '#558C22';
            ctx.lineWidth = 2;
            
            // Top Pipe
            ctx.fillRect(p.x, 0, PIPE_WIDTH, p.top);
            ctx.strokeRect(p.x, 0, PIPE_WIDTH, p.top);
            
            // Bottom Pipe
            ctx.fillRect(p.x, canvas.height - p.bottom, PIPE_WIDTH, p.bottom);
            ctx.strokeRect(p.x, canvas.height - p.bottom, PIPE_WIDTH, p.bottom);
            
            // Pipe Cap details (optional visual flair)
            ctx.fillStyle = '#73BF2E';
            ctx.fillRect(p.x - 2, p.top - 20, PIPE_WIDTH + 4, 20);
            ctx.strokeRect(p.x - 2, p.top - 20, PIPE_WIDTH + 4, 20);
            
            ctx.fillRect(p.x - 2, canvas.height - p.bottom, PIPE_WIDTH + 4, 20);
            ctx.strokeRect(p.x - 2, canvas.height - p.bottom, PIPE_WIDTH + 4, 20);
        }
    },
    
    update: function() {
        // Add new pipe
        if (frames % SPAWN_RATE === 0) {
            // Calculate random position
            // Min height for a pipe is 50px
            // Available space = canvas.height - ground(20) - gap - min_top(50) - min_bottom(50)
            const groundHeight = 20;
            const minPipeHeight = 50;
            const maxTop = canvas.height - groundHeight - minPipeHeight - PIPE_GAP;
            
            const topHeight = Math.floor(Math.random() * (maxTop - minPipeHeight + 1)) + minPipeHeight;
            const bottomHeight = canvas.height - groundHeight - PIPE_GAP - topHeight;
            
            this.items.push({
                x: canvas.width,
                top: topHeight,
                bottom: bottomHeight,
                passed: false
            });
        }
        
        // Move pipes
        for (let i = 0; i < this.items.length; i++) {
            let p = this.items[i];
            p.x -= 2; // Move speed
            
            // Collision Detection
            // Horizontal check
            if (bird.x + bird.radius > p.x && bird.x - bird.radius < p.x + PIPE_WIDTH) {
                // Vertical check
                if (bird.y - bird.radius < p.top || bird.y + bird.radius > canvas.height - p.bottom) {
                    gameOver();
                }
            }
            
            // Score update
            if (p.x + PIPE_WIDTH < bird.x && !p.passed) {
                score++;
                scoreDisplay.innerText = score;
                p.passed = true;
            }
            
            // Remove off-screen pipes
            if (p.x + PIPE_WIDTH < 0) {
                this.items.shift();
                i--;
            }
        }
    },
    
    reset: function() {
        this.items = [];
    }
};

const ground = {
    x: 0,
    height: 20,
    
    draw: function() {
        if (useWebGPU) return;

        ctx.fillStyle = '#DED895';
        ctx.fillRect(0, canvas.height - this.height, canvas.width, this.height);
        
        // Grass top
        ctx.fillStyle = '#73BF2E';
        ctx.fillRect(0, canvas.height - this.height, canvas.width, 4);
        ctx.strokeStyle = '#558C22';
        ctx.beginPath();
        ctx.moveTo(0, canvas.height - this.height);
        ctx.lineTo(canvas.width, canvas.height - this.height);
        ctx.stroke();
        
        // Moving effect
        ctx.strokeStyle = '#CBB968';
        ctx.beginPath();
        for(let i = this.x; i < canvas.width; i += 20) {
            ctx.moveTo(i, canvas.height - this.height + 5);
            ctx.lineTo(i - 10, canvas.height);
        }
        ctx.stroke();
    },
    
    update: function() {
        this.x -= 2;
        if (this.x <= -20) {
            this.x = 0;
        }
    }
};

// Game Loop
function loop() {
    if (useWebGPU) {
        // WebGPU Render Path
        webgpuRenderer.render({
            bird: bird,
            pipes: pipes.items,
            groundX: ground.x
        });
    } else {
        // Canvas 2D Render Path
        // Background
        ctx.fillStyle = '#70c5ce';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Clouds (simple decoration)
        drawClouds();
        
        pipes.draw();
        ground.draw();
        bird.draw();
    }
    
    if (gameState === 'PLAYING') {
        pipes.update();
        ground.update();
        bird.update();
        frames++;
    } else if (gameState === 'START') {
        ground.update();
        // Bobbing bird effect
        bird.y = 150 + Math.sin(Date.now() / 300) * 5;
        bird.rotation = 0; // Reset rotation for bobbing
    }
    
    if (gameState !== 'GAMEOVER') {
        requestAnimationFrame(loop);
    }
}

function drawClouds() {
    if (useWebGPU) return;
    
    ctx.fillStyle = '#FFF';
    // Just some static clouds for now, could animate them too
    ctx.beginPath();
    ctx.arc(100, 350, 30, 0, Math.PI * 2);
    ctx.arc(140, 360, 40, 0, Math.PI * 2);
    ctx.arc(180, 350, 30, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.beginPath();
    ctx.arc(250, 100, 30, 0, Math.PI * 2);
    ctx.arc(290, 110, 40, 0, Math.PI * 2);
    ctx.arc(330, 100, 30, 0, Math.PI * 2);
    ctx.fill();
}

// Controls
function startGame() {
    gameState = 'PLAYING';
    startScreen.classList.remove('active');
    scoreDisplay.style.display = 'block';
    bird.reset();
    pipes.reset();
    score = 0;
    frames = 0;
    scoreDisplay.innerText = score;
    bird.flap();
}

function gameOver() {
    gameState = 'GAMEOVER';
    gameOverScreen.classList.add('active');
    scoreDisplay.style.display = 'none';
    
    // Update High Score
    if (score > bestScore) {
        bestScore = score;
        localStorage.setItem('flappy_best_score', bestScore);
    }
    
    currentScoreEl.innerText = score;
    bestScoreEl.innerText = bestScore;
}

function resetGame() {
    gameState = 'START';
    gameOverScreen.classList.remove('active');
    startScreen.classList.add('active');
    bird.reset();
    pipes.reset();
    loop(); // Restart loop
}

function inputAction(e) {
    if (e.type === 'keydown' && e.code !== 'Space') return;
    if (e.type === 'keydown') e.preventDefault(); // Stop scrolling
    
    switch (gameState) {
        case 'START':
            startGame();
            break;
        case 'PLAYING':
            bird.flap();
            break;
        case 'GAMEOVER':
            // Optional: Click to restart immediately? 
            // Better to force button click to avoid accidental restarts
            break;
    }
}

// Event Listeners
startBtn.addEventListener('click', startGame);
restartBtn.addEventListener('click', resetGame);

window.addEventListener('keydown', inputAction);
canvas.addEventListener('mousedown', inputAction);
canvas.addEventListener('touchstart', (e) => {
    e.preventDefault(); // Prevent default touch actions
    inputAction(e);
}, {passive: false});

// Init
bestScoreEl.innerText = bestScore;
initRenderer().then(() => {
    loop();
});
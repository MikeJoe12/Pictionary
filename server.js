// server.js
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function createInitialGameState() {
    return {
        players: new Map(),
        viewers: new Set(),
        currentDrawer: null,
        currentWord: null,
        currentCategory: null,
        roundInProgress: false,
        roundTimeout: null,
        currentRound: 0,
        gameStarted: false,
        roundStartTime: null,
        words: {},
        usedWords: new Set(),
        correctGuessers: new Set(),
        canvasState: [],
        usernameToSockets: new Map(),
        lastDrawerIndex: -1
    };
}

let gameState = createInitialGameState();

function getRandomWord() {
    const categories = Object.keys(gameState.words);
    if (categories.length === 0) return null;

    let availableWords = [];
    categories.forEach(category => {
        const words = gameState.words[category];
        if (words) {
            words.forEach(word => {
                if (!gameState.usedWords.has(word)) {
                    availableWords.push({ word, category });
                }
            });
        }
    });

    if (availableWords.length === 0) {
        gameState.usedWords.clear();
        categories.forEach(category => {
            const words = gameState.words[category];
            if (words) {
                words.forEach(word => {
                    availableWords.push({ word, category });
                });
            }
        });
    }

    const selected = availableWords[Math.floor(Math.random() * availableWords.length)];
    if (selected) {
        gameState.currentCategory = selected.category;
        gameState.usedWords.add(selected.word);
        return selected.word;
    }
    return null;
}

function startNewRound() {
    if (!gameState.gameStarted) {
        io.emit('waitingForStart');
        return;
    }

    gameState.correctGuessers.clear();
    gameState.canvasState = [];
    // Reset hasGuessed for all players
    gameState.players.forEach(player => player.hasGuessed = false);

    if (gameState.roundTimeout) {
        clearTimeout(gameState.roundTimeout);
    }

    gameState.roundInProgress = true;
    gameState.currentRound++;

    const players = Array.from(gameState.players.values());
    if (players.length < 2) {
        gameState.gameStarted = false;
        io.emit('waitingForStart');
        return;
    }

    gameState.lastDrawerIndex = (gameState.lastDrawerIndex + 1) % players.length;
    const nextDrawer = players[gameState.lastDrawerIndex];
    
    gameState.currentDrawer = nextDrawer.username;
    players.forEach(p => p.isDrawing = (p.username === nextDrawer.username));

    gameState.currentWord = getRandomWord();
    gameState.roundStartTime = Date.now();

    const drawerSockets = gameState.usernameToSockets.get(nextDrawer.username) || [];
    io.emit('roundStart', {
        drawer: nextDrawer.username,
        round: gameState.currentRound,
        totalRounds: 5,
        category: gameState.currentCategory,
        startTime: gameState.roundStartTime
    });
    
    drawerSockets.forEach(socketId => {
        io.to(socketId).emit('wordToDraw', gameState.currentWord);
    });

    gameState.roundTimeout = setTimeout(() => {
        endRound("Time's up!", true);
    }, 40000);

    broadcastPlayersList(); // Update players list with cleared highlights
}

function endRound(reason, revealWord = false) {
    io.emit('roundEnd', {
        reason: reason,
        word: revealWord ? gameState.currentWord : null
    });
    gameState.roundInProgress = false;
    gameState.currentWord = null;
    gameState.roundStartTime = null;
    gameState.canvasState = [];
    
    setTimeout(startNewRound, 3000);
}

function broadcastPlayersList() {
    const playersList = Array.from(gameState.players.values()).map(p => ({
        username: p.username,
        score: p.score,
        isDrawing: p.username === gameState.currentDrawer,
        hasGuessed: p.hasGuessed || false
    }));
    io.emit('playersList', playersList);
}

function sendFullStateToSocket(socket, username) {
    if (gameState.roundInProgress) {
        socket.emit('roundStart', {
            drawer: gameState.currentDrawer,
            round: gameState.currentRound,
            totalRounds: 5,
            category: gameState.currentCategory,
            startTime: gameState.roundStartTime
        });

        if (username === gameState.currentDrawer) {
            socket.emit('wordToDraw', gameState.currentWord);
        }

        gameState.canvasState.forEach(drawData => {
            socket.emit('draw', drawData);
        });
    } else if (!gameState.gameStarted) {
        socket.emit('waitingForStart');
    }
    broadcastPlayersList();
}

io.on('connection', (socket) => {
    socket.on('resetGame', () => {
        if (gameState.roundTimeout) {
            clearTimeout(gameState.roundTimeout);
        }
        io.emit('gameReset');
        setTimeout(() => {
            gameState.usernameToSockets.forEach(sockets => {
                sockets.forEach(socketId => {
                    const clientSocket = io.sockets.sockets.get(socketId);
                    if (clientSocket) {
                        clientSocket.disconnect(true);
                    }
                });
            });
            gameState = createInitialGameState();
            io.emit('waitingForStart');
        }, 200);
    });

    socket.on('startGame', () => {
        if (!gameState.gameStarted && gameState.players.size >= 2) {
            gameState.gameStarted = true;
            gameState.currentRound = 0;
            startNewRound();
        } else if (gameState.players.size < 2) {
            io.emit('waitingForStart');
        }
    });

    socket.on('uploadWordList', (content) => {
        try {
            const lines = content.split('\n');
            const words = {};
            lines.forEach(line => {
                const [category, wordList] = line.split(':');
                if (category && wordList) {
                    words[category.trim()] = wordList.split(',').map(word => word.trim());
                }
            });
            gameState.words = words;
            gameState.usedWords.clear();
            socket.emit('wordListUploaded', true);
        } catch (err) {
            console.error('Error parsing word list:', err);
            socket.emit('wordListUploaded', false);
        }
    });

    socket.on('join', (username) => {
        let sockets = gameState.usernameToSockets.get(username) || [];
        if (!sockets.includes(socket.id)) {
            sockets.push(socket.id);
            gameState.usernameToSockets.set(username, sockets);
        }

        if (!gameState.players.has(username)) {
            gameState.players.set(username, {
                username: username,
                score: 0,
                isDrawing: username === gameState.currentDrawer,
                hasGuessed: false
            });
        }

        sendFullStateToSocket(socket, username);
    });

    socket.on('reconnectPlayer', (username) => {
        let sockets = gameState.usernameToSockets.get(username) || [];
        sockets = sockets.filter(id => id !== socket.id);
        sockets.push(socket.id);
        gameState.usernameToSockets.set(username, sockets);

        const player = gameState.players.get(username);
        if (player) {
            sendFullStateToSocket(socket, username);
        } else {
            socket.emit('waitingForStart');
        }
    });

    socket.on('draw', (data) => {
        const username = Array.from(gameState.usernameToSockets.entries())
            .find(([_, sockets]) => sockets.includes(socket.id))?.[0];
        if (username === gameState.currentDrawer) {
            gameState.canvasState.push(data);
            socket.broadcast.emit('draw', data);
        }
    });

    socket.on('clearCanvas', () => {
        const username = Array.from(gameState.usernameToSockets.entries())
            .find(([_, sockets]) => sockets.includes(socket.id))?.[0];
        if (username === gameState.currentDrawer) {
            gameState.canvasState = [];
            socket.broadcast.emit('clearCanvas');
        }
    });

    socket.on('guess', (message) => {
        const username = Array.from(gameState.usernameToSockets.entries())
            .find(([_, sockets]) => sockets.includes(socket.id))?.[0];
        if (username && 
            username !== gameState.currentDrawer && 
            gameState.currentWord && 
            !gameState.correctGuessers.has(username)) {
            
            const player = gameState.players.get(username);
            if (!player) return;
            
            if (message.toLowerCase().trim() === gameState.currentWord.toLowerCase()) {
                const basePoints = 10;
                const pointsDeduction = gameState.correctGuessers.size * 2;
                const points = Math.max(basePoints - pointsDeduction, 2);
                
                player.score += points;
                player.hasGuessed = true; // Mark player as having guessed correctly
                gameState.correctGuessers.add(username);

                const drawer = gameState.players.get(gameState.currentDrawer);
                if (drawer) {
                    drawer.score += 2;
                }

                io.emit('correctGuess', {
                    guesser: username,
                    points: points
                });

                broadcastPlayersList(); // Update players list with highlight

                const nonDrawingPlayers = gameState.players.size - 1;
                if (gameState.correctGuessers.size >= nonDrawingPlayers) {
                    endRound("Everyone guessed correctly!", true);
                }
            } else {
                io.emit('message', {
                    username: username,
                    message: message
                });
            }
        }
    });

    socket.on('disconnect', () => {
        const entry = Array.from(gameState.usernameToSockets.entries())
            .find(([_, sockets]) => sockets.includes(socket.id));
        if (!entry) return;

        const [username, sockets] = entry;
        const updatedSockets = sockets.filter(id => id !== socket.id);
        if (updatedSockets.length > 0) {
            gameState.usernameToSockets.set(username, updatedSockets);
        } else {
            gameState.usernameToSockets.delete(username);
        }

        const activePlayers = Array.from(gameState.usernameToSockets.keys());
        if (activePlayers.length < 2) {
            if (gameState.roundTimeout) {
                clearTimeout(gameState.roundTimeout);
            }
            gameState.roundInProgress = false;
            gameState.gameStarted = false;
            gameState.currentWord = null;
            io.emit('waitingForStart');
        }
        broadcastPlayersList();
    });

    socket.on('requestPlayerCount', () => {
        broadcastPlayersList();
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
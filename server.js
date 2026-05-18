const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game state
let gameState = {
  phase: 'lobby',       // lobby | spinning | answering | reveal | results
  currentWord: null,
  currentEmoji: null,
  options: [],
  correctAnswer: null,
  scores: {},           // { socketId: { name, score, streak, answers } }
  roundAnswers: {},     // { socketId: answer } for current round
  round: 0,
  totalRounds: 0,
  timeLeft: 15,
};

let timerInterval = null;

const VOCAB = [
  { word: 'Father',       emoji: '👨', hint: 'He is your parent' },
  { word: 'Mother',       emoji: '👩', hint: 'She is your parent' },
  { word: 'Brother',      emoji: '👦', hint: 'He is your sibling' },
  { word: 'Sister',       emoji: '👧', hint: 'She is your sibling' },
  { word: 'Baby',         emoji: '👶', hint: 'The youngest in the family' },
  { word: 'Grandfather',  emoji: '👴', hint: 'Your father\'s or mother\'s father' },
  { word: 'Grandmother',  emoji: '👵', hint: 'Your father\'s or mother\'s mother' },
  { word: 'Parents',      emoji: '👨‍👩‍', hint: 'Your father and mother together' },
  { word: 'Aunt',         emoji: '👩‍🦱', hint: 'Your parent\'s sister' },
  { word: 'Uncle',        emoji: '🧔', hint: 'Your parent\'s brother' },
  { word: 'Nephew',       emoji: '🧒', hint: 'Your sibling\'s son' },
  { word: 'Siblings',     emoji: '👫', hint: 'Your brothers and sisters' },
  { word: 'Cousin',       emoji: '🧑', hint: 'Your aunt or uncle\'s child' },
  { word: 'Niece',        emoji: '👧🏽', hint: 'Your sibling\'s daughter' },
  { word: 'Twins',        emoji: '👯', hint: 'Two siblings born at the same time' },
  { word: 'Triplets',     emoji: '👨‍👧‍👦', hint: 'Three siblings born at the same time' },
  { word: 'Grandchildren',emoji: '👧👦', hint: 'Your grandparents\' grandchildren' },
  { word: 'House',        emoji: '🏠', hint: 'Where your family lives' },
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getLeaderboard() {
  return Object.values(gameState.scores)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function startAnswerTimer() {
  gameState.timeLeft = 15;
  stopTimer();
  io.emit('timer', { timeLeft: gameState.timeLeft });
  timerInterval = setInterval(() => {
    gameState.timeLeft--;
    io.emit('timer', { timeLeft: gameState.timeLeft });
    if (gameState.timeLeft <= 0) {
      stopTimer();
      revealAnswers();
    }
  }, 1000);
}

function revealAnswers() {
  gameState.phase = 'reveal';
  // Calculate scores
  Object.entries(gameState.roundAnswers).forEach(([sid, answer]) => {
    if (!gameState.scores[sid]) return;
    if (answer === gameState.correctAnswer) {
      const timeBonus = Math.round(gameState.timeLeft * 6);
      const pts = 100 + timeBonus;
      gameState.scores[sid].score += pts;
      gameState.scores[sid].streak++;
      gameState.scores[sid].correct = (gameState.scores[sid].correct || 0) + 1;
    } else {
      gameState.scores[sid].streak = 0;
      gameState.scores[sid].wrong = (gameState.scores[sid].wrong || 0) + 1;
    }
  });
  io.emit('reveal', {
    correctAnswer: gameState.correctAnswer,
    roundAnswers: gameState.roundAnswers,
    leaderboard: getLeaderboard(),
  });
  // Notify each student of their result
  Object.entries(gameState.roundAnswers).forEach(([sid, answer]) => {
    const correct = answer === gameState.correctAnswer;
    const p = gameState.scores[sid];
    if (p) {
      io.to(sid).emit('myResult', { correct, score: p.score, streak: p.streak });
    }
  });
  // Students who didn't answer
  Object.keys(gameState.scores).forEach(sid => {
    if (!gameState.roundAnswers[sid]) {
      io.to(sid).emit('myResult', { correct: false, score: gameState.scores[sid].score, streak: 0, noAnswer: true });
    }
  });
}

// ===== SOCKET EVENTS =====
io.on('connection', (socket) => {

  // Student joins
  socket.on('joinGame', ({ name }) => {
    gameState.scores[socket.id] = { name, score: 0, streak: 0, correct: 0, wrong: 0, id: socket.id };
    socket.emit('joined', { phase: gameState.phase });
    io.emit('playerList', getLeaderboard());
    // Send current state if game in progress
    if (gameState.phase === 'answering') {
      socket.emit('newRound', {
        word: gameState.currentWord,
        emoji: gameState.currentEmoji,
        options: gameState.options,
        round: gameState.round,
        totalRounds: gameState.totalRounds,
        timeLeft: gameState.timeLeft,
      });
    }
  });

  // Host spins wheel — picks a word
  socket.on('spinResult', ({ word, emoji }) => {
    stopTimer();
    gameState.phase = 'answering';
    gameState.currentWord = word;
    gameState.currentEmoji = emoji;
    gameState.roundAnswers = {};
    gameState.round++;
    // Build options: correct + 3 random wrong
    const wrong = shuffle(VOCAB.filter(v => v.word !== word)).slice(0, 3).map(v => v.word);
    gameState.options = shuffle([word, ...wrong]);
    gameState.correctAnswer = word;
    io.emit('newRound', {
      word,
      emoji,
      options: gameState.options,
      round: gameState.round,
      totalRounds: gameState.totalRounds,
    });
    startAnswerTimer();
  });

  // Student submits answer
  socket.on('submitAnswer', ({ answer }) => {
    if (gameState.phase !== 'answering') return;
    if (gameState.roundAnswers[socket.id]) return; // already answered
    gameState.roundAnswers[socket.id] = answer;
    // Tell host someone answered
    io.emit('answerCount', {
      count: Object.keys(gameState.roundAnswers).length,
      total: Object.keys(gameState.scores).length,
    });
    // Check if everyone answered
    if (Object.keys(gameState.roundAnswers).length >= Object.keys(gameState.scores).length) {
      stopTimer();
      revealAnswers();
    }
  });

  // Host ends game
  socket.on('endGame', () => {
    stopTimer();
    gameState.phase = 'results';
    io.emit('gameOver', { leaderboard: getLeaderboard() });
  });

  // Host resets lobby
  socket.on('resetGame', () => {
    stopTimer();
    gameState = {
      phase: 'lobby', currentWord: null, currentEmoji: null,
      options: [], correctAnswer: null, scores: {},
      roundAnswers: {}, round: 0, totalRounds: 0, timeLeft: 15,
    };
    io.emit('reset');
  });

  // Disconnect
  socket.on('disconnect', () => {
    delete gameState.scores[socket.id];
    io.emit('playerList', getLeaderboard());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

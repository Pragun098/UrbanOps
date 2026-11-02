/**
 * UrbanOps Backend Express Server
 */

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { connectDB } = require('./config/db');
const telemetryRoutes = require('./routes/telemetry');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const allowedOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:3000';
app.use(
  cors({
    origin: allowedOrigin === '*' ? '*' : allowedOrigin,
    credentials: true,
  })
);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Telemetry Ingestion API Endpoint
app.use('/api/v1/telemetry', telemetryRoutes);

// Catch-all 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Server Error]:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server after connecting to MongoDB
const startServer = async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`[UrbanOps Server] Running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
      console.log(`[UrbanOps Server] Telemetry ingest endpoint available at POST http://localhost:${PORT}/api/v1/telemetry/ingest`);
    });
  } catch (error) {
    console.error('[UrbanOps Server] Failed to initialize database connection. Starting server without active DB connection...');
    // Still bind server to allow diagnostics, or exit according to environment
    app.listen(PORT, () => {
      console.warn(`[UrbanOps Server] Running on port ${PORT} (Database Offline)`);
    });
  }
};

startServer();

module.exports = app;

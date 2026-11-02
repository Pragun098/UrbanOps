/**
 * MongoDB Connection Module
 * 
 * Manages Mongoose connection lifecycle, environment resolution with local fallback,
 * event listeners for connection status, and graceful shutdown handling.
 */

const mongoose = require('mongoose');

const DEFAULT_FALLBACK_URI = 'mongodb://127.0.0.1:27017/urbanops';

/**
 * Connect to MongoDB instance using Mongoose.
 * Resolves connection string from process.env.MONGO_URI, falling back to local MongoDB.
 * 
 * @returns {Promise<typeof mongoose>}
 */
const connectDB = async () => {
  const mongoURI = process.env.MONGO_URI || DEFAULT_FALLBACK_URI;
  const isFallback = !process.env.MONGO_URI;

  if (isFallback) {
    console.warn(`[Database] MONGO_URI not provided in environment. Falling back to local default: ${DEFAULT_FALLBACK_URI}`);
  }

  try {
    const conn = await mongoose.connect(mongoURI, {
      autoIndex: process.env.NODE_ENV !== 'production', // Build indexes automatically in dev
      serverSelectionTimeoutMS: 5000,                  // Fail quickly if host unreachable
    });

    console.log(`[Database] MongoDB connected successfully: host=${conn.connection.host}, db=${conn.connection.name}`);
    return conn;
  } catch (error) {
    console.error('[Database] MongoDB initial connection error:', error.message);
    throw error;
  }
};

/**
 * Setup lifecycle listeners and graceful termination handling for process exit.
 */
const setupConnectionLifecycle = () => {
  const db = mongoose.connection;

  db.on('connected', () => {
    console.log('[Database] Mongoose connection established.');
  });

  db.on('error', (err) => {
    console.error('[Database] Mongoose connection error event:', err.message);
  });

  db.on('disconnected', () => {
    console.warn('[Database] Mongoose disconnected from MongoDB.');
  });

  db.on('reconnected', () => {
    console.log('[Database] Mongoose reconnected to MongoDB.');
  });

  // Graceful shutdown handlers
  const gracefulShutdown = async (signal) => {
    console.log(`\n[Database] Received ${signal}. Closing Mongoose connection gracefully...`);
    try {
      await mongoose.connection.close(false);
      console.log('[Database] Mongoose connection closed cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('[Database] Error closing Mongoose connection:', err.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
};

// Initialize lifecycle hooks immediately upon loading
setupConnectionLifecycle();

module.exports = {
  connectDB,
  mongoose,
  DEFAULT_FALLBACK_URI,
};

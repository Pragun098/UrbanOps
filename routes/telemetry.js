/**
 * Telemetry Ingestion Routes
 * 
 * Express router handling client and operational telemetry ingestion at:
 * POST /api/v1/telemetry/ingest
 */

const express = require('express');
const router = express.Router();
const RawData = require('../models/RawData');

/**
 * Helper to extract client IP address accurately, handling reverse proxies
 * (X-Forwarded-For) and standard socket connections.
 * 
 * @param {express.Request} req
 * @returns {string}
 */
const extractClientIp = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    // X-Forwarded-For can contain comma-separated IPs (client, proxy1, proxy2)
    const ips = forwardedFor.split(',').map((ip) => ip.trim());
    if (ips.length > 0 && ips[0]) {
      return ips[0];
    }
  }
  return req.socket?.remoteAddress || req.ip || 'unknown';
};

/**
 * @route   POST /api/v1/telemetry/ingest
 * @desc    Ingest un-sanitized raw telemetry and operational event logs
 * @access  Public / Client Internal
 */
router.post('/ingest', async (req, res) => {
  try {
    const { source, eventType, payload } = req.body;

    // Validate required fields
    const missingFields = [];
    if (!source || typeof source !== 'string' || source.trim() === '') {
      missingFields.push('source (non-empty string)');
    }
    if (!eventType || typeof eventType !== 'string' || eventType.trim() === '') {
      missingFields.push('eventType (non-empty string)');
    }
    if (payload === undefined || payload === null) {
      missingFields.push('payload (valid JSON object or value)');
    }

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed: Missing or invalid required fields',
        missing: missingFields,
      });
    }

    // Extract connection metadata
    const ipAddress = extractClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const timestamp = new Date();

    // Persist raw telemetry document in MongoDB
    const telemetryDoc = await RawData.create({
      source: source.trim(),
      eventType: eventType.trim(),
      payload,
      metadata: {
        ipAddress,
        userAgent,
        timestamp,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Telemetry event ingested successfully',
      data: {
        id: telemetryDoc._id,
        source: telemetryDoc.source,
        eventType: telemetryDoc.eventType,
        createdAt: telemetryDoc.createdAt,
      },
    });
  } catch (error) {
    console.error('[Telemetry Ingestion Error]:', error);

    // Differentiate Mongoose validation errors if any arise
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing telemetry payload',
    });
  }
});

module.exports = router;

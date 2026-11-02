/**
 * RawData Model
 * 
 * Stores un-sanitized raw telemetry and operational event logs received from clients,
 * external reporters, and operational command services.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const MetadataSchema = new Schema(
  {
    ipAddress: {
      type: String,
      default: 'unknown',
    },
    userAgent: {
      type: String,
      default: 'unknown',
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const RawDataSchema = new Schema(
  {
    // Origin identifier of the telemetry source (e.g. 'urbanops-web-frontend', 'urbanops-mobile-app')
    source: {
      type: String,
      required: [true, 'Telemetry source is required'],
      trim: true,
      index: true,
    },

    // Nature / category of the recorded event (e.g. 'USER_ACTION_DISPATCHED', 'REPORT_SUBMISSION_ATTEMPT')
    eventType: {
      type: String,
      required: [true, 'Event type is required'],
      trim: true,
      index: true,
    },

    // Flexible payload holding un-sanitized JSON telemetry details
    payload: {
      type: Schema.Types.Mixed,
      required: [true, 'Telemetry payload is required'],
    },

    // Connection and client environment metadata
    metadata: {
      type: MetadataSchema,
      default: () => ({}),
    },
  },
  {
    // Automatically manage createdAt and updatedAt
    timestamps: true,
  }
);

// Index on createdAt for retention management and time-window queries
RawDataSchema.index({ createdAt: -1 });

// Compound index for querying specific events by source in chronological order
RawDataSchema.index({ source: 1, eventType: 1, createdAt: -1 });

const RawData = mongoose.models.RawData || mongoose.model('RawData', RawDataSchema);

module.exports = RawData;

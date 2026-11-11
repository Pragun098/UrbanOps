/** Allowed browser origins, shared by Express CORS and Socket.io. */
const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const corsOptions = {
  origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  credentials: !allowedOrigins.includes('*'),
};

module.exports = { allowedOrigins, corsOptions };

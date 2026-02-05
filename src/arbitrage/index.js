const { detectSimpleArbitrage } = require('./simple');
const { detectTriangularArbitrage } = require('./triangular');

module.exports = { detectSimpleArbitrage, detectTriangularArbitrage };

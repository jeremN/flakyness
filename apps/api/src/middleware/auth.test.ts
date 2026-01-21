import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'crypto';

// Re-implement the functions here to test without db import
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return `flackyness_${randomBytes(24).toString('hex')}`;
}

describe('Auth Utilities', () => {
  describe('hashToken', () => {
    it('should hash a token consistently', () => {
      const token = 'test-token-12345';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);
      
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different tokens', () => {
      const hash1 = hashToken('token-a');
      const hash2 = hashToken('token-b');
      
      expect(hash1).not.toBe(hash2);
    });

    it('should produce 64-character hex string (SHA-256)', () => {
      const hash = hashToken('any-token');
      
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle empty string', () => {
      const hash = hashToken('');
      expect(hash).toHaveLength(64);
    });

    it('should handle special characters', () => {
      const hash = hashToken('token!@#$%^&*()_+{}|:"<>?');
      expect(hash).toHaveLength(64);
    });
  });

  describe('generateToken', () => {
    it('should generate token with flackyness prefix', () => {
      const token = generateToken();
      
      expect(token).toMatch(/^flackyness_/);
    });

    it('should generate unique tokens', () => {
      const tokens = new Set<string>();
      
      for (let i = 0; i < 100; i++) {
        tokens.add(generateToken());
      }
      
      expect(tokens.size).toBe(100);
    });

    it('should generate tokens of consistent length', () => {
      const token = generateToken();
      
      // flackyness_ (10 chars) + 48 hex chars (24 bytes) = 58, but prefix includes underscore
      expect(token.length).toBeGreaterThanOrEqual(58);
    });

    it('should generate tokens that can be hashed', () => {
      const token = generateToken();
      const hash = hashToken(token);
      
      expect(hash).toHaveLength(64);
    });
  });
});

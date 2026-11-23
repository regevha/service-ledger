import { test, expect } from '@playwright/test';
test('proof: a deliberately red test (ci-ok must fail)', async () => { expect(1).toBe(2); });

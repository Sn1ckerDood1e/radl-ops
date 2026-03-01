import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/paths.js', () => ({
  getConfig: vi.fn(() => ({ knowledgeDir: '/tmp/test-knowledge' })),
}));

vi.mock('../with-error-tracking.js', () => ({
  withErrorTracking: vi.fn((_name: string, handler: Function) => handler),
}));

describe('repo-map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateRepoMap', () => {
    it('returns message when no files found for scope', async () => {
      // getScopedFiles returns [] when git command fails (no matches)
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('grep: no match');
      });

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('nonexistent');

      expect(result).toContain('No files found matching scope');
      expect(result).toContain('"nonexistent"');
      expect(result).toContain('Try broader keywords');
    });

    it('shows file count in header', async () => {
      // First call: getScopedFiles (git ls-files | grep)
      vi.mocked(execSync)
        .mockReturnValueOnce('src/auth/login.ts\nsrc/auth/signup.ts\nsrc/auth/utils.ts\n')
        // Subsequent calls: extractExports for each file
        .mockReturnValueOnce('export function loginUser\n')
        .mockReturnValueOnce('export function signupUser\n')
        .mockReturnValueOnce('export const AUTH_KEY\n');

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('auth');

      expect(result).toContain('"auth" (3 files)');
    });

    it('caps output at 3000 chars with truncation marker', async () => {
      // Create enough files to exceed 3000 chars
      const files = Array.from({ length: 50 }, (_, i) =>
        `src/components/very-long-directory-name/very-long-file-name-${i}.ts`
      ).join('\n');

      vi.mocked(execSync)
        .mockReturnValueOnce(files)
        // Each extractExports call returns a long export list
        .mockImplementation(() =>
          'export function veryLongFunctionNameThatTakesUpSpace\nexport const anotherLongConstantName\nexport class VeryLongClassName\nexport type VeryLongTypeName\n'
        );

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('components');

      expect(result.length).toBeLessThanOrEqual(3000 + '...(truncated)'.length + 1);
      expect(result).toContain('...(truncated)');
    });

    it('builds tree with exports for matched files', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce('src/lib/auth.ts\nsrc/lib/utils.ts\n')
        .mockReturnValueOnce('export function validateToken\nexport const SECRET_KEY\n')
        .mockReturnValueOnce('export function slugify\n');

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('lib');

      expect(result).toContain('src/lib/');
      expect(result).toContain('auth.ts');
      expect(result).toContain('validateToken');
      expect(result).toContain('slugify');
    });
  });

  describe('getScopedFiles (via generateRepoMap)', () => {
    it('sanitizes scope input by removing special chars', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('no match');
      });

      const { generateRepoMap } = await import('./repo-map.js');
      generateRepoMap('auth; rm -rf /');

      // The regex [^a-z0-9-] strips everything except alphanumeric and hyphens,
      // including spaces, semicolons, and slashes — producing "authrm-rf"
      expect(vi.mocked(execSync)).toHaveBeenCalledWith(
        expect.stringContaining('"authrm-rf"'),
        expect.anything()
      );
      // Special chars like ; and / should be stripped
      expect(vi.mocked(execSync)).not.toHaveBeenCalledWith(
        expect.stringContaining(';'),
        expect.anything()
      );
    });

    it('returns empty array on git error causing no-files message', async () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('anything');

      expect(result).toContain('No files found');
    });
  });

  describe('extractExports (via generateRepoMap)', () => {
    it('parses function, const, class, type, and interface exports', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce('src/models/user.ts\n')
        .mockReturnValueOnce(
          'export function createUser\n' +
          'export const DEFAULT_ROLE\n' +
          'export class UserService\n' +
          'export type UserRole\n' +
          'export interface UserProfile\n'
        );

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('user');

      expect(result).toContain('createUser');
      expect(result).toContain('DEFAULT_ROLE');
      expect(result).toContain('UserService');
      expect(result).toContain('UserRole');
      expect(result).toContain('UserProfile');
    });

    it('returns empty exports on grep error, showing file without arrow', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce('src/empty/file.ts\n')
        // extractExports grep fails
        .mockImplementation(() => {
          throw new Error('grep: no match');
        });

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('empty');

      // File should appear without an arrow (no exports)
      expect(result).toContain('file.ts');
      expect(result).not.toMatch(/file\.ts\s+→/);
    });
  });

  describe('buildTree (via generateRepoMap)', () => {
    it('groups files by directory', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce(
          'src/api/auth.ts\n' +
          'src/api/users.ts\n' +
          'src/lib/helpers.ts\n'
        )
        .mockReturnValueOnce('export function login\n')
        .mockReturnValueOnce('export function getUsers\n')
        .mockReturnValueOnce('export function helper\n');

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('src');

      expect(result).toContain('src/api/');
      expect(result).toContain('src/lib/');
    });

    it('shows export names after arrow for files with exports', async () => {
      vi.mocked(execSync)
        .mockReturnValueOnce('src/utils/format.ts\n')
        .mockReturnValueOnce('export function formatDate\nexport function formatCurrency\n');

      const { generateRepoMap } = await import('./repo-map.js');
      const result = generateRepoMap('format');

      expect(result).toMatch(/format\.ts\s+→\s+formatDate, formatCurrency/);
    });
  });

  describe('registerRepoMapTools', () => {
    it('registers the repo_map tool on the server', async () => {
      const mockTool = vi.fn();
      const mockServer = { tool: mockTool } as any;

      const { registerRepoMapTools } = await import('./repo-map.js');
      registerRepoMapTools(mockServer);

      expect(mockTool).toHaveBeenCalledTimes(1);
      expect(mockTool).toHaveBeenCalledWith(
        'repo_map',
        expect.any(String),
        expect.objectContaining({
          scope: expect.anything(),
        }),
        expect.any(Function),
      );
    });

    it('handler invokes generateRepoMap and returns text content', async () => {
      const handlers: Record<string, Function> = {};
      const mockServer = {
        tool: (...args: unknown[]) => {
          const name = args[0] as string;
          handlers[name] = args[args.length - 1] as Function;
        },
      };

      // Set up mock so generateRepoMap returns no-files message
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('no match');
      });

      const { registerRepoMapTools } = await import('./repo-map.js');
      registerRepoMapTools(mockServer as any);

      const result = await handlers['repo_map']({ scope: 'test-scope' });
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('No files found');
    });
  });
});

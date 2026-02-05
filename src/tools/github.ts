/**
 * GitHub Tools - Manage issues, PRs, and code in the Radl repo
 *
 * Permission tiers:
 * - read: List issues, PRs, stats (automatic)
 * - create: Create issues (automatic)
 * - modify: Comment on issues (automatic, configurable)
 * - external: Create PRs, merge code (requires approval)
 */

import { z } from 'zod';
import { Octokit } from 'octokit';
import type { Tool, ToolResult, ToolExecutionContext } from '../types/index.js';
import { config } from '../config/index.js';
import { toolRegistry } from './registry.js';
import { logger } from '../config/logger.js';

// Lazy initialization to avoid startup errors if token not configured
let octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokit) {
    if (!config.github.token) {
      throw new Error('GitHub token not configured');
    }
    octokit = new Octokit({ auth: config.github.token });
  }
  return octokit;
}

const owner = config.github.owner;
const repo = config.github.repo;

// ============================================
// Input Validation Schemas
// ============================================

const listIssuesSchema = z.object({
  labels: z.string().optional(),
  state: z.enum(['open', 'closed', 'all']).optional().default('open'),
  limit: z.number().min(1).max(100).optional().default(10),
});

const createIssueSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().min(1).max(65536),
  labels: z.array(z.string()).optional(),
});

const getIssueSchema = z.object({
  issue_number: z.number().int().positive(),
});

const commentIssueSchema = z.object({
  issue_number: z.number().int().positive(),
  body: z.string().min(1).max(65536),
});

const listPRsSchema = z.object({
  state: z.enum(['open', 'closed', 'all']).optional().default('open'),
  limit: z.number().min(1).max(100).optional().default(10),
});

// ============================================
// Tools
// ============================================

/**
 * List GitHub issues
 */
const listIssues: Tool = {
  name: 'github_list_issues',
  description: 'List open issues from the Radl GitHub repository. Can filter by labels.',
  category: 'github',
  permissionTier: 'read',
  parameters: {
    labels: {
      type: 'string',
      description: 'Comma-separated list of labels to filter by',
      optional: true,
    },
    state: {
      type: 'string',
      description: 'Issue state: open, closed, or all',
      optional: true,
      enum: ['open', 'closed', 'all'],
      default: 'open',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of issues to return (default 10, max 100)',
      optional: true,
      default: 10,
    },
  },
  inputSchema: listIssuesSchema,
  rateLimit: 30, // 30 calls per minute
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = listIssuesSchema.parse(params);
      const client = getOctokit();

      const response = await client.rest.issues.listForRepo({
        owner,
        repo,
        state: validated.state,
        labels: validated.labels || undefined,
        per_page: validated.limit,
      });

      const issues = response.data.map(issue => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name)),
        created_at: issue.created_at,
        url: issue.html_url,
      }));

      return { success: true, data: issues };
    } catch (error) {
      logger.error('github_list_issues failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list issues',
      };
    }
  },
};

/**
 * Create a GitHub issue
 */
const createIssue: Tool = {
  name: 'github_create_issue',
  description: 'Create a new issue in the Radl GitHub repository',
  category: 'github',
  permissionTier: 'create',
  parameters: {
    title: {
      type: 'string',
      description: 'Issue title (required)',
    },
    body: {
      type: 'string',
      description: 'Issue body/description (required)',
    },
    labels: {
      type: 'array',
      description: 'Labels to add to the issue',
      optional: true,
    },
  },
  inputSchema: createIssueSchema,
  rateLimit: 10, // 10 creates per minute
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = createIssueSchema.parse(params);
      const client = getOctokit();

      const response = await client.rest.issues.create({
        owner,
        repo,
        title: validated.title,
        body: validated.body,
        labels: validated.labels || undefined,
      });

      return {
        success: true,
        data: {
          number: response.data.number,
          title: response.data.title,
          url: response.data.html_url,
        },
      };
    } catch (error) {
      logger.error('github_create_issue failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create issue',
      };
    }
  },
};

/**
 * Get issue details
 */
const getIssue: Tool = {
  name: 'github_get_issue',
  description: 'Get details of a specific issue including comments',
  category: 'github',
  permissionTier: 'read',
  parameters: {
    issue_number: {
      type: 'number',
      description: 'The issue number',
    },
  },
  inputSchema: getIssueSchema,
  rateLimit: 30,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = getIssueSchema.parse(params);
      const client = getOctokit();

      const [issueResponse, commentsResponse] = await Promise.all([
        client.rest.issues.get({
          owner,
          repo,
          issue_number: validated.issue_number,
        }),
        client.rest.issues.listComments({
          owner,
          repo,
          issue_number: validated.issue_number,
        }),
      ]);

      return {
        success: true,
        data: {
          number: issueResponse.data.number,
          title: issueResponse.data.title,
          body: issueResponse.data.body,
          state: issueResponse.data.state,
          labels: issueResponse.data.labels.map(l =>
            typeof l === 'string' ? l : l.name
          ),
          created_at: issueResponse.data.created_at,
          updated_at: issueResponse.data.updated_at,
          url: issueResponse.data.html_url,
          comments: commentsResponse.data.map(c => ({
            id: c.id,
            body: c.body,
            user: c.user?.login,
            created_at: c.created_at,
          })),
        },
      };
    } catch (error) {
      logger.error('github_get_issue failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get issue',
      };
    }
  },
};

/**
 * Add comment to issue
 */
const commentOnIssue: Tool = {
  name: 'github_comment_issue',
  description: 'Add a comment to an existing issue',
  category: 'github',
  permissionTier: 'modify',
  parameters: {
    issue_number: {
      type: 'number',
      description: 'The issue number',
    },
    body: {
      type: 'string',
      description: 'Comment text',
    },
  },
  inputSchema: commentIssueSchema,
  rateLimit: 10,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = commentIssueSchema.parse(params);
      const client = getOctokit();

      const response = await client.rest.issues.createComment({
        owner,
        repo,
        issue_number: validated.issue_number,
        body: validated.body,
      });

      return {
        success: true,
        data: {
          id: response.data.id,
          url: response.data.html_url,
        },
      };
    } catch (error) {
      logger.error('github_comment_issue failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add comment',
      };
    }
  },
};

/**
 * List pull requests
 */
const listPRs: Tool = {
  name: 'github_list_prs',
  description: 'List pull requests from the Radl repository',
  category: 'github',
  permissionTier: 'read',
  parameters: {
    state: {
      type: 'string',
      description: 'PR state: open, closed, or all',
      optional: true,
      enum: ['open', 'closed', 'all'],
      default: 'open',
    },
    limit: {
      type: 'number',
      description: 'Maximum number of PRs to return (default 10, max 100)',
      optional: true,
      default: 10,
    },
  },
  inputSchema: listPRsSchema,
  rateLimit: 30,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = listPRsSchema.parse(params);
      const client = getOctokit();

      const response = await client.rest.pulls.list({
        owner,
        repo,
        state: validated.state,
        per_page: validated.limit,
      });

      const prs = response.data.map(pr => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        draft: pr.draft,
        user: pr.user?.login,
        created_at: pr.created_at,
        url: pr.html_url,
      }));

      return { success: true, data: prs };
    } catch (error) {
      logger.error('github_list_prs failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list PRs',
      };
    }
  },
};

/**
 * Get repository stats
 */
const getRepoStats: Tool = {
  name: 'github_repo_stats',
  description: 'Get repository statistics including commits, contributors, and recent activity',
  category: 'github',
  permissionTier: 'read',
  parameters: {},
  rateLimit: 10, // Expensive API calls
  async execute(params, context): Promise<ToolResult> {
    try {
      const client = getOctokit();

      const [repoResponse, commitsResponse, contributorsResponse] = await Promise.all([
        client.rest.repos.get({ owner, repo }),
        client.rest.repos.listCommits({ owner, repo, per_page: 10 }),
        client.rest.repos.listContributors({ owner, repo, per_page: 10 }),
      ]);

      return {
        success: true,
        data: {
          name: repoResponse.data.name,
          description: repoResponse.data.description,
          stars: repoResponse.data.stargazers_count,
          forks: repoResponse.data.forks_count,
          open_issues: repoResponse.data.open_issues_count,
          default_branch: repoResponse.data.default_branch,
          recent_commits: commitsResponse.data.map(c => ({
            sha: c.sha.substring(0, 7),
            message: c.commit.message.split('\n')[0],
            author: c.commit.author?.name,
            date: c.commit.author?.date,
          })),
          top_contributors: contributorsResponse.data.map(c => ({
            login: c.login,
            contributions: c.contributions,
          })),
        },
      };
    } catch (error) {
      logger.error('github_repo_stats failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get repo stats',
      };
    }
  },
};

/**
 * Close an issue
 */
const closeIssue: Tool = {
  name: 'github_close_issue',
  description: 'Close an existing GitHub issue',
  category: 'github',
  permissionTier: 'delete', // Requires approval
  parameters: {
    issue_number: {
      type: 'number',
      description: 'The issue number to close',
    },
    reason: {
      type: 'string',
      description: 'Optional comment explaining why the issue is being closed',
      optional: true,
    },
  },
  inputSchema: z.object({
    issue_number: z.number().int().positive(),
    reason: z.string().optional(),
  }),
  rateLimit: 5,
  async execute(params, context): Promise<ToolResult> {
    try {
      const validated = z.object({
        issue_number: z.number().int().positive(),
        reason: z.string().optional(),
      }).parse(params);

      const client = getOctokit();

      // Add comment if reason provided
      if (validated.reason) {
        await client.rest.issues.createComment({
          owner,
          repo,
          issue_number: validated.issue_number,
          body: `Closing: ${validated.reason}`,
        });
      }

      await client.rest.issues.update({
        owner,
        repo,
        issue_number: validated.issue_number,
        state: 'closed',
      });

      return {
        success: true,
        data: { message: `Issue #${validated.issue_number} closed` },
      };
    } catch (error) {
      logger.error('github_close_issue failed', { error });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to close issue',
      };
    }
  },
};

// ============================================
// Registration
// ============================================

export function registerGitHubTools(): void {
  if (!config.github.token) {
    logger.warn('GitHub token not configured, skipping GitHub tool registration');
    return;
  }

  toolRegistry.register(listIssues);
  toolRegistry.register(createIssue);
  toolRegistry.register(getIssue);
  toolRegistry.register(commentOnIssue);
  toolRegistry.register(listPRs);
  toolRegistry.register(getRepoStats);
  toolRegistry.register(closeIssue);

  logger.info('GitHub tools registered', { count: 7 });
}

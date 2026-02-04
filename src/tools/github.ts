/**
 * GitHub Tool - Manage issues, PRs, and code in the Radl repo
 */

import { Octokit } from 'octokit';
import type { Tool, ToolResult } from '../types/index.js';
import { config } from '../config/index.js';
import { toolRegistry } from './registry.js';

const octokit = new Octokit({
  auth: config.github.token,
});

const owner = config.github.owner;
const repo = config.github.repo;

/**
 * List GitHub issues
 */
const listIssues: Tool = {
  name: 'github_list_issues',
  description: 'List open issues from the Radl GitHub repository. Can filter by labels.',
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
    },
    limit: {
      type: 'number',
      description: 'Maximum number of issues to return (default 10)',
      optional: true,
    },
  },
  async execute(params): Promise<ToolResult> {
    try {
      const response = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: (params.state as 'open' | 'closed' | 'all') || 'open',
        labels: params.labels as string || undefined,
        per_page: (params.limit as number) || 10,
      });

      const issues = response.data.map(issue => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map(l => typeof l === 'string' ? l : l.name),
        created_at: issue.created_at,
        url: issue.html_url,
      }));

      return { success: true, data: issues };
    } catch (error) {
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
  parameters: {
    title: {
      type: 'string',
      description: 'Issue title',
    },
    body: {
      type: 'string',
      description: 'Issue body/description',
    },
    labels: {
      type: 'array',
      description: 'Labels to add to the issue',
      optional: true,
    },
  },
  requiresApproval: true,
  async execute(params): Promise<ToolResult> {
    try {
      const response = await octokit.rest.issues.create({
        owner,
        repo,
        title: params.title as string,
        body: params.body as string,
        labels: params.labels as string[] || undefined,
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
  parameters: {
    issue_number: {
      type: 'number',
      description: 'The issue number',
    },
  },
  async execute(params): Promise<ToolResult> {
    try {
      const [issueResponse, commentsResponse] = await Promise.all([
        octokit.rest.issues.get({
          owner,
          repo,
          issue_number: params.issue_number as number,
        }),
        octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: params.issue_number as number,
        }),
      ]);

      return {
        success: true,
        data: {
          number: issueResponse.data.number,
          title: issueResponse.data.title,
          body: issueResponse.data.body,
          state: issueResponse.data.state,
          labels: issueResponse.data.labels.map(l => typeof l === 'string' ? l : l.name),
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
  requiresApproval: true,
  async execute(params): Promise<ToolResult> {
    try {
      const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: params.issue_number as number,
        body: params.body as string,
      });

      return {
        success: true,
        data: {
          id: response.data.id,
          url: response.data.html_url,
        },
      };
    } catch (error) {
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
  parameters: {
    state: {
      type: 'string',
      description: 'PR state: open, closed, or all',
      optional: true,
    },
    limit: {
      type: 'number',
      description: 'Maximum number of PRs to return (default 10)',
      optional: true,
    },
  },
  async execute(params): Promise<ToolResult> {
    try {
      const response = await octokit.rest.pulls.list({
        owner,
        repo,
        state: (params.state as 'open' | 'closed' | 'all') || 'open',
        per_page: (params.limit as number) || 10,
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
  parameters: {},
  async execute(): Promise<ToolResult> {
    try {
      const [repoResponse, commitsResponse, contributorsResponse] = await Promise.all([
        octokit.rest.repos.get({ owner, repo }),
        octokit.rest.repos.listCommits({ owner, repo, per_page: 10 }),
        octokit.rest.repos.listContributors({ owner, repo, per_page: 10 }),
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
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get repo stats',
      };
    }
  },
};

// Register all GitHub tools
export function registerGitHubTools(): void {
  toolRegistry.register(listIssues);
  toolRegistry.register(createIssue);
  toolRegistry.register(getIssue);
  toolRegistry.register(commentOnIssue);
  toolRegistry.register(listPRs);
  toolRegistry.register(getRepoStats);
}

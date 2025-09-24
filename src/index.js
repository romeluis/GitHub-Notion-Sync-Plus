// Load environment variables at the very beginning
require('dotenv').config();

const NotionClient = require('./NotionClient');
const GitHubClient = require('./GitHubClient');
const SyncManager = require('./SyncManager');
const ConfigManager = require('./ConfigManager');
const Logger = require('./Logger');
const WebhookHandler = require('./WebhookHandler');

class GitHubNotionSync {
    constructor() {
        this.logger = new Logger('GitHubNotionSync');
        this.config = null;
        this.notion = null;
        this.github = null;
        this.syncManager = null;
        this.webhookHandler = null;
    }

    /**
     * Initialize all components
     */
    async initialize() {
        try {
            this.logger.info('Initializing GitHub-Notion Sync Plus...');

            // Initialize configuration
            this.config = new ConfigManager();

            // Initialize clients
            this.notion = new NotionClient(
                this.config.getNotionToken(),
                this.config.getBugDatabaseId(),
                this.config.getTaskDatabaseId()
            );

            this.github = new GitHubClient(
                this.config.getGitHubToken(),
                this.logger
            );

            // Initialize sync manager
            this.syncManager = new SyncManager(
                this.notion,
                this.github,
                this.config
            );

            this.logger.info('Initialization completed successfully');

        } catch (error) {
            this.logger.error('Initialization failed:', error);
            throw error;
        }
    }

    /**
     * Run the synchronization process continuously at intervals
     * @param {number} intervalMinutes - Interval in minutes between syncs
     */
    async runScheduled(intervalMinutes = 5) {
        const intervalMs = intervalMinutes * 60 * 1000;
        
        this.logger.info(`Starting scheduled sync every ${intervalMinutes} minutes...`);
        
        // Run initial sync
        try {
            await this.runOnce();
        } catch (error) {
            this.logger.error('Initial sync failed, but scheduler will continue:', error.message);
        }
        
        // Set up interval
        const interval = setInterval(async () => {
            try {
                this.logger.info('--- Starting scheduled sync ---');
                await this.runOnce();
                this.logger.info('--- Scheduled sync completed ---\n');
            } catch (error) {
                this.logger.error('Scheduled sync failed:', error.message);
                // Don't stop the scheduler, just log the error and continue
            }
        }, intervalMs);
        
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            this.logger.info('\nReceived SIGINT. Stopping scheduler...');
            clearInterval(interval);
            process.exit(0);
        });
        
        process.on('SIGTERM', () => {
            this.logger.info('\nReceived SIGTERM. Stopping scheduler...');
            clearInterval(interval);
            process.exit(0);
        });
        
        this.logger.info('Scheduler started. Press Ctrl+C to stop.');
        
        // Keep the process alive
        return new Promise(() => {}); // Never resolves, keeps running
    }

    /**
     * Run a single synchronization (renamed from run for clarity)
     */
    async runOnce() {
        try {
            await this.initialize();

            this.logger.info('Starting synchronization process...');

            // Perform the sync
            const results = await this.syncManager.performFullSync();

            // Log summary
            this.logSyncSummary(results);

            this.logger.info('Synchronization completed successfully');
            return results;

        } catch (error) {
            this.logger.error('Synchronization failed:', error);
            throw error;
        }
    }

    /**
     * Run the synchronization process (backward compatibility)
     */
    async run() {
        return await this.runOnce();
    }

    /**
     * Log synchronization summary
     * @param {Object} results - Sync results
     */
    logSyncSummary(results) {
        this.logger.info('\n=== SYNCHRONIZATION SUMMARY ===');
        this.logger.info(`✅ Created: ${results.created} GitHub issues`);
        this.logger.info(`🔄 Updated: ${results.updated} items`);
        this.logger.info(`❌ Deleted: ${results.deleted} issues`);
        this.logger.info(`🚨 Failed: ${results.failed} operations`);
        this.logger.info(`📊 Total: ${results.operations.length} operations`);

        if (results.failed > 0) {
            this.logger.warn('\nFailed operations:');
            results.operations
                .filter(op => !op.success)
                .forEach(op => {
                    this.logger.warn(`- ${op.action}: ${op.error}`);
                });
        }

        this.logger.info('=== END SUMMARY ===\n');
    }

    /**
     * Run a dry run (no actual changes)
     */
    async dryRun() {
        try {
            await this.initialize();

            this.logger.info('Starting dry run (no changes will be made)...');

            // Fetch data from both sources
            const [notionData, githubIssues] = await Promise.all([
                this.notion.fetchAllItems(),
                this.github.fetchAllSyncedIssues(this.config.getAllRepositories())
            ]);

            const allItems = [...notionData.bugs, ...notionData.tasks];

            // Create mappings and determine operations
            const { bugMap, issueMap } = this.syncManager.createMappings(allItems, githubIssues);
            const operations = this.syncManager.determineSyncOperations(bugMap, issueMap);

            // Log what would be done
            this.logger.info('\n=== DRY RUN RESULTS ===');
            this.logger.info(`Found ${notionData.bugs.length} bugs and ${notionData.tasks.length} tasks in Notion`);
            this.logger.info(`Found ${githubIssues.length} synced issues in GitHub`);
            this.logger.info(`Would perform ${operations.length} operations:`);

            const actionCounts = operations.reduce((acc, op) => {
                acc[op.action] = (acc[op.action] || 0) + 1;
                return acc;
            }, {});

            Object.entries(actionCounts).forEach(([action, count]) => {
                this.logger.info(`  - ${action}: ${count}`);
            });

            // Log details of each operation
            if (operations.length > 0) {
                this.logger.info('\nDetailed operations:');
                operations.forEach((op, index) => {
                    this.logger.info(`${index + 1}. ${op.action}: ${op.reason}`);
                });
            }

            this.logger.info('=== DRY RUN COMPLETE ===\n');
            return operations;

        } catch (error) {
            this.logger.error('Dry run failed:', error);
            throw error;
        }
    }

    /**
     * Start webhook server alongside scheduled sync
     * @param {number} intervalMinutes - Sync interval in minutes
     * @param {number} webhookPort - Port for webhook server
     */
    async runWithWebhooks(intervalMinutes = 5, webhookPort = 3000) {
        try {
            this.logger.info('Starting GitHub-Notion Sync Plus with webhook server...');

            await this.initialize();

            // Initialize webhook handler
            this.webhookHandler = new WebhookHandler(
                this.config,
                this.github,
                this.notion,
                this.logger
            );

            // Start webhook server
            await this.webhookHandler.start(webhookPort);

            // Start scheduled sync (this will run indefinitely)
            await this.runScheduled(intervalMinutes);

        } catch (error) {
            this.logger.error('Failed to start webhook server with sync:', error);
            throw error;
        }
    }

    /**
     * Stop all services
     */
    async stop() {
        if (this.webhookHandler) {
            this.webhookHandler.stop();
        }
        this.logger.info('All services stopped');
    }
}

// CLI interface
if (require.main === module) {
    const app = new GitHubNotionSync();
    
    const command = process.argv[2];
    const interval = parseInt(process.argv[3]) || 5; // Default 5 minutes
    const webhookPort = parseInt(process.argv[4]) || 3000; // Default port 3000
    
    if (command === 'dry-run') {
        app.dryRun()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
    } else if (command === 'schedule') {
        app.runScheduled(interval)
            .catch(() => process.exit(1));
    } else if (command === 'webhook') {
        // Run webhook server with scheduled sync
        app.runWithWebhooks(interval, webhookPort)
            .catch(() => process.exit(1));
    } else if (command === 'once') {
        app.runOnce()
            .then(() => process.exit(0))
            .catch(() => process.exit(1));
    } else {
        // Default to webhook mode with syncing if no command specified
        console.log('No command specified, starting webhook server with scheduled sync...');
        app.runWithWebhooks(interval, webhookPort)
            .catch(() => process.exit(1));
    }
}

module.exports = GitHubNotionSync;

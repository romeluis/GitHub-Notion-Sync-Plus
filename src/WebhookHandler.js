 const express = require('express');
const cors = require('cors');

/**
 * WebhookHandler manages Notion webhook actions for branch creation
 * Handles both Bug and Task database webhooks when buttons are pressed
 */
class WebhookHandler {
    constructor(config, githubClient, notionClient, logger) {
        this.config = config;
        this.github = githubClient;
        this.notion = notionClient;
        this.logger = logger;
        this.app = express();
        this.server = null;
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        // Enable CORS for webhook endpoint
        this.app.use(cors({
            origin: ['https://notion.so', 'https://www.notion.so'],
            methods: ['POST', 'GET'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));

        // Parse JSON bodies
        this.app.use(express.json());

        // Request logging
        this.app.use((req, res, next) => {
            this.logger.info(`${req.method} ${req.path}`, {
                userAgent: req.get('User-Agent'),
                contentType: req.get('Content-Type'),
                ip: req.ip || req.connection.remoteAddress
            });
            next();
        });
    }

    /**
     * Setup Express routes
     */
    setupRoutes() {
        // Main webhook endpoint for Notion webhook actions
        this.app.post('/webhook/notion', this.handleNotionWebhook.bind(this));
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok', 
                service: 'GitHub-Notion Sync Plus',
                webhook: 'active',
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                version: '1.0.0'
            });
        });

        // Root endpoint with instructions
        this.app.get('/', (req, res) => {
            res.json({
                service: 'GitHub-Notion Sync Plus Webhook Server',
                status: 'running',
                timestamp: new Date().toISOString(),
                endpoints: {
                    webhook: 'POST /webhook/notion',
                    health: 'GET /health',
                    test: 'POST /webhook/test'
                },
                webhookUrl: `https://capstonesync.romeluis.com/webhook/notion`,
                tunnelUrl: `http://localhost:3000`,
                uptime: process.uptime()
            });
        });

        // Test endpoint for webhook testing
        this.app.post('/webhook/test', (req, res) => {
            this.logger.info('Test webhook received', { 
                body: req.body,
                headers: {
                    'content-type': req.get('Content-Type'),
                    'user-agent': req.get('User-Agent')
                },
                query: req.query
            });
            res.json({
                status: 'received',
                message: 'Test webhook processed successfully',
                receivedData: req.body,
                timestamp: new Date().toISOString()
            });
        });
    }

    /**
     * Handle incoming Notion webhook actions
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    async handleNotionWebhook(req, res) {
        try {
            this.logger.info('Received Notion webhook action', { 
                body: req.body,
                headers: {
                    'content-type': req.get('Content-Type'),
                    'user-agent': req.get('User-Agent'),
                    'content-length': req.get('Content-Length')
                },
                method: req.method,
                url: req.url,
                bodyType: typeof req.body,
                bodyKeys: req.body ? Object.keys(req.body) : []
            });

            // Validate request has body
            if (!req.body || Object.keys(req.body).length === 0) {
                this.logger.warn('Received webhook with empty body');
                return res.status(400).json({ 
                    error: 'Empty webhook payload',
                    message: 'Webhook body is required'
                });
            }

            // Respond immediately to prevent timeout (Notion expects quick response)
            res.status(200).json({ 
                status: 'received', 
                timestamp: new Date().toISOString(),
                message: 'Webhook received and will be processed asynchronously'
            });

            // Process webhook asynchronously to avoid blocking
            setImmediate(() => this.processWebhookAsync(req.body, req.headers));

        } catch (error) {
            this.logger.error('Error handling webhook:', error);
            
            // Only respond if headers haven't been sent
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Webhook processing failed',
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    /**
     * Process webhook data asynchronously
     * @param {Object} webhookData - Notion webhook action data
     * @param {Object} headers - Request headers
     */
    async processWebhookAsync(webhookData, headers = {}) {
        try {
            this.logger.info('Processing webhook action asynchronously', { 
                webhookData,
                userAgent: headers['user-agent'],
                contentType: headers['content-type']
            });

            // Check if this is a branch creation action
            if (this.isBranchCreationAction(webhookData)) {
                this.logger.info('Webhook identified as branch creation action');
                await this.createBranchFromWebhook(webhookData);
            } else {
                this.logger.info('Webhook action not related to branch creation', {
                    reason: 'Missing required fields (title, id, or module)',
                    availableFields: Object.keys(webhookData || {})
                });
            }

        } catch (error) {
            this.logger.error('Error processing webhook asynchronously:', error);
            // Consider adding retry logic or dead letter queue here
        }
    }

    /**
     * Check if webhook action is for branch creation
     * @param {Object} webhookData - Webhook payload
     * @returns {boolean} True if this is a branch creation action
     */
    isBranchCreationAction(webhookData) {
        // Notion webhook actions send database page properties
        // We need to look for properties that indicate a bug/task record
        // Common properties might include: Title, ID, Module, Type, Status, etc.
        
        this.logger.info('Analyzing webhook payload structure', { 
            keys: Object.keys(webhookData || {}),
            payload: webhookData 
        });

        // Check for common Notion database properties
        if (webhookData && typeof webhookData === 'object') {
            // Look for title property (common in Notion databases)
            const hasTitle = webhookData.Title || webhookData.title || webhookData.Name || webhookData.name;
            // Look for ID property (like CBUG-1 or TSK-1)
            const hasId = webhookData.ID || webhookData.id || webhookData['Bug ID'] || webhookData['Task ID'];
            // Look for module/type properties
            const hasModule = webhookData.Module || webhookData.module || webhookData.Component;
            
            this.logger.info('Webhook property analysis', {
                hasTitle: !!hasTitle,
                hasId: !!hasId,
                hasModule: !!hasModule,
                titleValue: hasTitle,
                idValue: hasId,
                moduleValue: hasModule
            });

            return !!(hasTitle && (hasId || hasModule));
        }

        return false;
    }

    /**
     * Create a branch based on webhook data
     * @param {Object} webhookData - Contains database properties from Notion
     */
    async createBranchFromWebhook(webhookData) {
        try {
            // Extract data from webhook payload (Notion database properties)
            const title = this.extractTitle(webhookData);
            const id = this.extractId(webhookData);
            const module = this.extractModule(webhookData);
            const type = this.extractType(webhookData);
            
            this.logger.info('Creating branch from webhook data', {
                id, title, module, type, rawData: webhookData
            });

            if (!title || !id) {
                this.logger.error('Missing required data for branch creation', { 
                    title, id, module, type 
                });
                return;
            }

            // Get repository from module mapping
            const repository = this.getRepositoryFromModule(module);
            if (!repository) {
                this.logger.error('Unknown module, cannot create branch', { module });
                return;
            }

            // Generate branch name using same format as issues: [type]/ID-title
            const branchName = this.generateBranchName(id, title, type);

            // Create branch from main
            const branchResult = await this.github.createBranch(repository, branchName, 'main');
            
            if (branchResult) {
                this.logger.info('Successfully created branch', {
                    repository,
                    branchName,
                    branchUrl: branchResult.url
                });

                // Update Notion with branch link
                await this.updateNotionWithBranchLink(id, branchResult.url, webhookData);
                
            } else {
                this.logger.warn('Branch already exists or creation failed', {
                    repository, branchName
                });
            }

        } catch (error) {
            this.logger.error('Error creating branch from webhook:', error);
        }
    }

    /**
     * Extract title from webhook data
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Title value
     */
    extractTitle(webhookData) {
        return webhookData.Title || 
               webhookData.title || 
               webhookData.Name || 
               webhookData.name || 
               webhookData['Bug Title'] ||
               webhookData['Task Title'] ||
               null;
    }

    /**
     * Extract ID from webhook data
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} ID value
     */
    extractId(webhookData) {
        return webhookData.ID || 
               webhookData.id || 
               webhookData['Bug ID'] || 
               webhookData['Task ID'] ||
               webhookData.Number ||
               webhookData.number ||
               null;
    }

    /**
     * Extract module from webhook data
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Module value
     */
    extractModule(webhookData) {
        return webhookData.Module || 
               webhookData.module || 
               webhookData.Component || 
               webhookData.component ||
               webhookData.Area ||
               webhookData.area ||
               'Application'; // Default fallback
    }

    /**
     * Extract type from webhook data
     * @param {Object} webhookData - Webhook payload
     * @returns {string|null} Type value
     */
    extractType(webhookData) {
        return webhookData.Type || 
               webhookData.type || 
               webhookData.Category || 
               webhookData.category ||
               'feature'; // Default fallback
    }

    /**
     * Generate branch name from bug/task data
     * @param {string} id - Bug/Task ID (CBUG-1 or TSK-1)
     * @param {string} title - Issue title
     * @param {string} type - Issue type
     * @returns {string} Branch name
     */
    generateBranchName(id, title, type) {
        // Convert title to safe branch name
        const safeTitle = title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
            .replace(/\s+/g, '-')         // Replace spaces with hyphens
            .substring(0, 40);            // Limit length

        // Format: feature/CBUG-1-fix-login-issue
        const prefix = id.startsWith('TSK-') ? 'task' : 'feature';
        return `${prefix}/${id}-${safeTitle}`;
    }

    /**
     * Get repository from module name
     * @param {string} module - Module name (Application/Firmware)
     * @returns {string|null} Repository path or null
     */
    getRepositoryFromModule(module) {
        try {
            const moduleMapping = JSON.parse(this.config.get('MODULE_MAPPING'));
            return moduleMapping[module] || null;
        } catch (error) {
            this.logger.error('Error parsing module mapping:', error);
            return null;
        }
    }

    /**
     * Update Notion with branch link
     * @param {string} id - Bug/Task ID
     * @param {string} branchUrl - GitHub branch URL
     * @param {Object} webhookData - Original webhook data for context
     */
    async updateNotionWithBranchLink(id, branchUrl, webhookData) {
        try {
            // This would need to be implemented based on whether it's a Bug or Task
            // For now, we'll log the action
            this.logger.info('Would update Notion with branch link', {
                id, branchUrl, type: id.startsWith('TSK-') ? 'Task' : 'Bug'
            });

            // TODO: Implement Notion API call to update branch link field
            // This would require knowing the page ID from the webhook or finding it by ID

        } catch (error) {
            this.logger.error('Error updating Notion with branch link:', error);
        }
    }

    /**
     * Start the webhook server
     * @param {number} port - Port to listen on
     * @returns {Promise} Resolves when server is ready
     */
    start(port = 3000) {
        return new Promise((resolve) => {
            this.server = this.app.listen(port, () => {
                this.logger.info(`Webhook server listening on port ${port}`);
                this.logger.info(`Health check: http://localhost:${port}/health`);
                this.logger.info(`Webhook URL: http://localhost:${port}/webhook/notion`);
                this.logger.info(`Test endpoint: http://localhost:${port}/webhook/test`);
                resolve();
            });
        });
    }

    /**
     * Stop the webhook server
     */
    stop() {
        if (this.server) {
            this.server.close();
            this.logger.info('Webhook server stopped');
        }
    }
}

module.exports = WebhookHandler;

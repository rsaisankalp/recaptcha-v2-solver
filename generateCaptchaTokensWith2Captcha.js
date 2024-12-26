const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const dotenv = require('dotenv');
const createLogger = require('./utils/logger');
const fs = require('fs').promises;
const path = require('path');

let logger = createLogger({ level: 'info' });

// Add this function to handle directory deletion
async function cleanupUserDataDirs(baseDir) {
    try {
        logger.info('Cleaning up previous Chrome user data...');
        
        // Check if directory exists
        try {
            await fs.access(baseDir);
        } catch {
            // Directory doesn't exist, nothing to clean
            return;
        }

        // Read all items in the directory
        const items = await fs.readdir(baseDir);
        
        // Delete each chrome-user-data directory
        for (const item of items) {
            if (item.startsWith('chrome-user-data-')) {
                const fullPath = path.join(baseDir, item);
                try {
                    await fs.rm(fullPath, { recursive: true, force: true });
                    logger.debug(`Deleted ${fullPath}`);
                } catch (err) {
                    logger.warn(`Failed to delete ${fullPath}: ${err.message}`);
                }
            }
        }
        
        logger.info('Chrome user data cleanup completed');
    } catch (error) {
        logger.error(`Error cleaning up Chrome user data: ${error.message}`);
    }
}

dotenv.config();
puppeteerExtra.use(StealthPlugin());



class ResultTracker {
    constructor() {
        this.results = [];
        this.startTime = Date.now();
        this.maxResults = 500;
        this.firstProcessingTime = null;
    }

    addResult(result) {
        if (!this.firstProcessingTime) {
            this.firstProcessingTime = Date.now();
        }

        this.results.push({
            success: result.token ? true : false,  // Success is based on getting a token
            timestamp: Date.now()
        });

        if (this.results.length > this.maxResults) {
            this.results.shift();
        }

        // Automatically print stats after adding a result
        this.printStats();
    }

    getStats() {
        if (this.results.length === 0) return null;

        const successCount = this.results.filter(r => r.success).length;
        const successRate = (successCount / this.results.length) * 100;

        let avgTimePerToken = 0;
        if (successCount > 0) {
            const totalElapsedSeconds = (Date.now() - this.startTime) / 1000;
            avgTimePerToken = totalElapsedSeconds / successCount;
        }

        return {
            successRate: successRate.toFixed(2),
            avgTimePerToken: avgTimePerToken.toFixed(2),
            totalAttempts: this.results.length,
            successfulTokens: successCount
        };
    }

    printStats() {
        const stats = this.getStats();
        if (!stats) return;
        logger.info(`Stats: Success Rate: ${stats.successRate}% | Avg Time/Token: ${stats.avgTimePerToken}s | Total Attempts: ${stats.totalAttempts} | Successful Tokens: ${stats.successfulTokens}`);
    }
}


// Add this as a global variable after the ResultTracker class
const resultTracker = new ResultTracker();

// Add this at the top level of the file, after other constants
let currentChromeDataDirIndex = 0;

// Add defaultUserAgents at the top of the file after the imports
const defaultUserAgents = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

// Modify extractCapchaTokens function
async function generateCaptchaTokensWith2Captcha({ 
    // Core settings
    eventEmitter,
    tokensToGenerate = Infinity,
    concurrentBrowsers = 6,
    tabsPerBrowser = 1,
    captchaUrl = 'https://www.google.com/recaptcha/api2/demo',
    // Browser settings
    browser = {
        headless: true,
        executablePath: os.platform().startsWith('win') 
            ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" 
            : "/usr/bin/google-chrome",
        userDataDir: './chrome-user-data',
        userAgents: defaultUserAgents  // Use defaultUserAgents as default value
    },
    // Proxy settings
    proxy = {
        enabled: false,
        host: null,
        port: null,
        username: null,
        password: null
    },
    // 2captcha configuration
    "2captcha": config2captcha = {
        apiKey: null
    },
    // Logger configuration
    logger: loggerConfig = {
        level: 'info'    // 'error' | 'warn' | 'info' | 'debug' | 'silent'
    }
} = {}) {
    // Update the global logger with user config
    logger = createLogger({ level: loggerConfig.level });

    // Add cleanup call at the start
    await cleanupUserDataDirs(browser.userDataDir);

    if (!eventEmitter) {
        throw new Error('eventEmitter is required');
    }

    if (!config2captcha.apiKey) {
        throw new Error('2captcha API key is required');
    }

    // Convert proxy config to internal format if enabled
    const proxyConfig = proxy.enabled ? {
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password
    } : null;

    logger.info('\n=== Starting 2Captcha Token Generation ===');
    logger.info(`Concurrent Browsers: ${concurrentBrowsers}`);
    logger.info(`Tabs per Browser: ${tabsPerBrowser}`);
    logger.info(`Captcha URL: ${captchaUrl}`);
    logger.info('=========================================\n');

    let shouldContinue = true;

    // Use provided user agents or fall back to default array
    const activeUserAgents = browser.userAgents || defaultUserAgents;

    while (shouldContinue) {
        try {
            // Launch browsers with unique data directories
            const browsers = await Promise.all(
                Array.from({ length: concurrentBrowsers }, async (_, index) => {
                    await new Promise(resolve => setTimeout(resolve, index * 1000));
                    currentChromeDataDirIndex = (currentChromeDataDirIndex % 20) + 1;
                    const chromeDataDir = `${browser.userDataDir}/chrome-user-data-${currentChromeDataDirIndex}`;
                    return launchBrowser(chromeDataDir, proxyConfig, browser.headless, activeUserAgents, browser);
                })
            );

            try {
                const allPromises = [];
                let tokensGenerated = 0;

                for (let browserIndex = 0; browserIndex < browsers.length; browserIndex++) {
                    const browser = browsers[browserIndex];
                    const tabPromises = [];

                    const remainingTokens = tokensToGenerate - tokensGenerated;
                    const tabsForThisBrowser = Math.min(tabsPerBrowser, remainingTokens);

                    for (let tabIndex = 0; tabIndex < tabsForThisBrowser; tabIndex++) {
                        const tabPromise = (async () => {
                            let page = null;
                            try {
                                page = await browser.newPage();
                                const result = await attemptCaptcha(page, config2captcha);
                                
                                if (result && result.token) {
                                    eventEmitter.emit('tokenGenerated', { token: result.token });
                                    resultTracker.addResult({ success: true });
                                    tokensGenerated++;
                                } else {
                                    eventEmitter.emit('tokenError', { error: 'Failed to get token' });
                                    resultTracker.addResult({ success: false });
                                }

                            } catch (error) {
                                logger.error('Error processing captcha:', error);
                                resultTracker.addResult({ success: false });
                            } finally {
                                if (page) {
                                    await page.close().catch(err =>
                                        logger.error('Error closing page:', err)
                                    );
                                }
                            }
                        })();

                        tabPromises.push(tabPromise);
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }

                    allPromises.push(...tabPromises);
                }

                await Promise.all(allPromises);

            } finally {
                // Close browsers
                await Promise.all(browsers.map(browser => browser.close().catch(() => { })));
            }

            shouldContinue = false;

        } catch (error) {
            logger.error('Token generation error:', error.message);
            resultTracker.addResult({ success: false });
            shouldContinue = false;
        }
    }
}

// Update launchBrowser function to remove request interception setup
async function launchBrowser(userDataDir, proxyConfig = null, headless = true, activeUserAgents, browserConfig) {
    const randomProfile = Math.floor(Math.random() * 4) + 1;

    const browser = await puppeteerExtra.launch({
        headless: headless,
        executablePath: browserConfig.executablePath,
        userDataDir: userDataDir,
        protocolTimeout: 30000,
        args: [
            '--no-sandbox',
            '--disable-gpu',
            '--enable-webgl',
            '--window-size=1920,1080',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            '--password-store=basic',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--lang=en',
            '--disable-web-security',
            '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end',
            `--profile-directory=Profile ${randomProfile}`,
            proxyConfig ? `--proxy-server=${proxyConfig.host}:${proxyConfig.port}` : ''
        ].filter(Boolean),
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
        defaultViewport: null,
    });

    // Set user agent for all new pages
    browser.on('targetcreated', async (target) => {
        const page = await target.page();
        if (page) {
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                delete navigator.__proto__.webdriver;
            });
            
            const randomUserAgent = activeUserAgents[Math.floor(Math.random() * activeUserAgents.length)];
            await page.setUserAgent(randomUserAgent);
            
            await page.setDefaultTimeout(30000);
            await page.setDefaultNavigationTimeout(30000);

            // Set proxy authentication if provided
            if (proxyConfig?.username && proxyConfig?.password) {
                await page.authenticate({
                    username: proxyConfig.username,
                    password: proxyConfig.password
                });
            }
        }
    });

    return browser;
}

// Update solve2Captcha function to accept userAgent parameter
async function solve2Captcha(sitekey, pageUrl, apiKey, userAgent) {
    try {
        logger.info('Initiating 2captcha solve request...');

        // Get the current page's user agent from the browser
        const taskData = {
            clientKey: apiKey,
            task: {
                type: "RecaptchaV2TaskProxyless",
                websiteURL: pageUrl,
                websiteKey: sitekey,
                userAgent: userAgent,  // Use the passed userAgent
                isInvisible: false
            }
        };

        const createTaskResponse = await axios.post('https://api.2captcha.com/createTask', taskData);
        logger.debug('Create task response:', createTaskResponse.data);

        if (createTaskResponse.data.errorId !== 0) {
            throw new Error(`Failed to create captcha task: ${createTaskResponse.data.errorDescription}`);
        }

        const taskId = createTaskResponse.data.taskId;
        logger.info('Got task ID:', taskId);

        // Poll for the result
        let attempts = 0;
        const maxAttempts = 60;

        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 10000));

            const resultResponse = await axios.post('https://api.2captcha.com/getTaskResult', {
                clientKey: apiKey,
                taskId: taskId
            });

            if (resultResponse.data.status === 'ready') {
                logger.info('Solution found!');
                return resultResponse.data.solution.token;
            }

            attempts++;
        }

        throw new Error('Timeout waiting for captcha solution');
    } catch (error) {
        logger.error('Error in solve2Captcha:', error);
        throw error;
    }
}

// Add this new function for finding captcha frame
async function findCaptchaFrame(page, timeout = 10000) {
    try {
        const frame = await page.waitForFrame(frame =>
            frame.url().includes('api2/anchor'),
            { timeout }
        );

        logger.info('Found anchor frame');

        const checkbox = await frame.waitForSelector('.recaptcha-checkbox-border', {
            visible: true,
            timeout
        });

        const isClickable = await frame.evaluate(() => {
            const checkbox = document.querySelector('.recaptcha-checkbox-border');
            if (!checkbox) return false;

            const style = window.getComputedStyle(checkbox);
            return !checkbox.disabled &&
                style.visibility !== 'hidden' &&
                style.display !== 'none';
        });

        if (!isClickable) {
            logger.warn('Checkbox found but not clickable');
            return null;
        }

        logger.info('Checkbox is ready');
        return { frame, checkbox };

    } catch (error) {
        logger.error('Error finding captcha:', error.message);
        return null;
    }
}

// Update the solveCaptchaChallenge function
async function solveCaptchaChallenge(page, config2captcha) {
    try {
        // Get the current page's user agent
        const userAgent = await page.evaluate(() => navigator.userAgent);
        
        // Use the frame detection method
        const captchaElements = await findCaptchaFrame(page);
        if (!captchaElements) {
            logger.error('Failed to find captcha elements');
            return null;
        }

        // Extract sitekey directly from the frame URL
        const frameUrl = captchaElements.frame.url();
        const sitekey = new URL(frameUrl).searchParams.get('k');

        logger.info('Sitekey found in frame URL:', sitekey);

        if (!sitekey) {
            logger.error('Could not find reCAPTCHA sitekey in frame URL');
            return null;
        }

        const pageUrl = page.url();
        logger.info('Using page URL:', pageUrl);
        logger.info('Using sitekey:', sitekey);

        try {
            // Pass userAgent to solve2Captcha
            const solution = await solve2Captcha(sitekey, pageUrl, config2captcha.apiKey, userAgent);
            logger.info('Got solution from 2captcha:', solution.slice(0, 50) + '...');

            // Insert the solution
            await page.evaluate((token) => {
                document.querySelector('#g-recaptcha-response').value = token;
                document.querySelector('#g-recaptcha-response').style.display = 'block';

                try {
                    window.___grecaptcha_cfg.clients[0].K.K.callback(token);
                } catch (e) {
                    const form = document.querySelector('form');
                    if (form) form.submit();
                }
            }, solution);

            return solution;

        } catch (error) {
            logger.error('Error solving captcha with 2captcha:', error);
            return null;
        }
    } catch (error) {
        logger.error('Error in solveCaptchaChallenge:', error);
        return null;
    }
}

// Update the attemptCaptcha function
async function attemptCaptcha(page, config2captcha) {
    try {
        logger.info('Loading demo page...');
        await page.goto('https://www.google.com/recaptcha/api2/demo', {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });

        // Start timing
        const captchaStartTime = Date.now();

        // Solve captcha using existing method
        logger.info('Attempting to solve captcha...');
        const solvedToken = await solveCaptchaChallenge(page, config2captcha);

        if (solvedToken) {
            const captchaSolveTime = (Date.now() - captchaStartTime) / 1000;
            logger.info(`Successfully solved captcha in ${captchaSolveTime.toFixed(2)} seconds`);

            return {
                status: 'SUCCESS',
                token: solvedToken
            };
        }

        logger.warn('Failed to solve captcha');
        return null;

    } catch (error) {
        logger.error('Error processing captcha:', error);
        return null;
    }
}

module.exports = generateCaptchaTokensWith2Captcha;
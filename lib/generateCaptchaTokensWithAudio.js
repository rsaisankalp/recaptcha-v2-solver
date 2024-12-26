const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const undici = require('undici');
const createLogger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');

// Initialize with default level, will be updated when the main function is called
let logger = createLogger({ level: 'info' });




const BROWSER_CLEANUP_DELAY = 400; // ms to wait after browser closes
const userDataDirs = new Set(); // Track which user data dirs are in use
const MAX_USER_DATA_DIRS = 15;  // Pool of 10 possible directories

// Setup puppeteer with stealth plugin
puppeteerExtra.use(StealthPlugin());


// ResultTracker class (keeping this as a class since it manages state)
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
            success: result.success,
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

// Browser management functions
async function launchBrowser(userDataDir, proxyConfig = null, headless = true, activeUserAgents, browserConfig) {
    userDataDirs.add(userDataDir);
    const randomProfile = Math.floor(Math.random() * 4) + 1;

    try {
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

        // Update page configuration
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

                if (proxyConfig?.username && proxyConfig?.password) {
                    await page.authenticate({
                        username: proxyConfig.username,
                        password: proxyConfig.password
                    });
                }
            }
        });

        // Add cleanup function
        browser.cleanup = async () => {
            try {
                await browser.close();
            } catch (error) {
                logger.error(`Error closing browser: ${error.message}`);
            }
            await new Promise(resolve => setTimeout(resolve, BROWSER_CLEANUP_DELAY));
            userDataDirs.delete(userDataDir);
        };

        return browser;
    } catch (error) {
        userDataDirs.delete(userDataDir);
        throw error;
    }
}


// Add audio transcription function
async function downloadAndTranscribeAudio(audioUrl, witConfig) {
    try {
        let audioData;
        let downloadAttempts = 0;
        const maxDownloadAttempts = 3;
        
        while (downloadAttempts < maxDownloadAttempts) {
            try {
                downloadAttempts++;
                logger.debug(`Audio download attempt ${downloadAttempts}/${maxDownloadAttempts}`);
                
                const audioResponse = await axios.get(audioUrl, {
                    responseType: 'arraybuffer',
                    validateStatus: false,
                    timeout: 60000
                });

                if (audioResponse.status !== 200) {
                    throw new Error(`Failed to download audio: ${audioResponse.status}`);
                }

                audioData = audioResponse.data;
                logger.info('Audio downloaded successfully');
                break;

            } catch (downloadError) {
                logger.error(`Audio download attempt ${downloadAttempts} failed: ${downloadError.message}`);
                if (downloadAttempts === maxDownloadAttempts) return null;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const witToken = witConfig.apiKeys[Math.floor(Math.random() * witConfig.apiKeys.length)];

        logger.info('Transcribing with wit.ai...');
        const witResponse = await undici.request('https://api.wit.ai/speech?v=20220622', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${witToken}`,
                'Content-Type': 'audio/mpeg3'
            },
            body: audioData,
            bodyTimeout: 120000,
            headersTimeout: 120000
        });

        let fullResponse = '';
        for await (const chunk of witResponse.body) {
            fullResponse += chunk.toString();
        }

        const lastTextMatch = fullResponse.match(/"text":\s*"([^"]+)"/g);
        if (!lastTextMatch) {
            logger.error('No transcription found');
            return null;
        }

        const lastText = lastTextMatch[lastTextMatch.length - 1];
        const audioTranscript = lastText.match(/"text":\s*"([^"]+)"/)[1];
        logger.info('Transcribed text:', audioTranscript);

        return audioTranscript;

    } catch (error) {
        logger.error(`Error in transcription: ${error.message}`);
        return null;
    }
}

async function findCaptchaFrame(page, timeout = 10000) {
    try {
        // Wait for the frame to be attached
        const frame = await page.waitForFrame(frame => 
            frame.url().includes('api2/anchor'), 
            { timeout }
        );
        
        logger.info('Found anchor frame');

        // Wait for the checkbox to be ready
        const checkbox = await frame.waitForSelector('.recaptcha-checkbox-border', {
            visible: true,
            timeout
        });

        // Verify the checkbox is actually clickable
        const isClickable = await frame.evaluate(() => {
            const checkbox = document.querySelector('.recaptcha-checkbox-border');
            if (!checkbox) return false;

            const style = window.getComputedStyle(checkbox);
            return !checkbox.disabled && 
                   style.visibility !== 'hidden' && 
                   style.display !== 'none';
        });

        if (!isClickable) {
            logger.info('Checkbox found but not clickable');
            return null;
        }

        // Ensure checkbox is in viewport
        await frame.evaluate(() => {
            const checkbox = document.querySelector('.recaptcha-checkbox-border');
            if (checkbox) {
                checkbox.scrollIntoView({ block: 'center', inline: 'center' });
            }
        });

        logger.info('Checkbox is ready');
        return { frame, checkbox };

    } catch (error) {
        logger.error(`Error finding captcha: ${error.message}`);
        return null;
    }
}


async function waitForToken(page, maxAttempts = 50) {
    try {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                // Check for token
                const token = await page.evaluate(() => {
                    const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                    return textarea && textarea.value ? textarea.value : null;
                });

                if (token) {
                    logger.info('Token found');
                    return token;
                }

            } catch (evalError) {
                if (!evalError.message.includes('Execution context was destroyed') && !evalError.message.includes('Attempted to use detached Frame')  && !evalError.message.includes('Target closed')) {
                    logger.error(`Evaluation error: ${evalError.message}`);
                }
                return null;
            }

            // Wait a bit before next attempt
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return null;

    } catch (error) {
        logger.error(`Error in waitForToken: ${error.message}`);
        return null;
    }
}

async function waitForChallengeFrame(page, timeout = 10000) {
    try {
        // Wait for the bframe to be attached
        const frame = await page.waitForFrame(
            frame => frame.url().includes('api2/bframe'),
            { timeout }
        );
        
        // Wait for the challenge to be visible
        await frame.waitForSelector('.rc-doscaptcha-header-text, #recaptcha-audio-button', {
            visible: true,
            timeout
        });

        logger.info('Challenge frame ready');
        return frame;

    } catch (error) {
        // Ignore browser/target closed errors
        if (error.message.includes('Target closed') || 
            error.message.includes('Protocol error') ||
            error.message.includes('Execution context was destroyed') ||
            error.message.includes('frame got detached') ||
            error.message.includes('Frame was detached')) {
            return null;
        }
        
        // Log other types of errors
        if (error.name === 'TimeoutError') {
            logger.warn('Challenge frame did not appear within timeout');
        } else {
            logger.error(`Error waiting for challenge frame: ${error.message}`);
        }
        return null;
    }
}


async function checkForFailedChallenge(frame) {
    try {
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                const errorElement = await frame.$('.rc-audiochallenge-error-message');
                if (errorElement) {
                    const isVisible = await frame.evaluate(el => {
                        const style = window.getComputedStyle(el);
                        return style.display !== 'none' && style.visibility !== 'hidden';
                    }, errorElement);

                    if (isVisible) {
                        const errorText = await frame.evaluate(el => el.textContent, errorElement);
                        if (errorText.includes('Multiple correct solutions required')) {
                            return true;
                        }
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                if (!error.message.includes('Execution context was destroyed') && !error.message.includes('Attempted to use detached Frame')) {
                    return false;
                }
            }
        }
        return false;
    } catch (error) {
        return false;
    }
}

async function waitForAudioChallenge(frame, maxAttempts = 50) {
    try {
        logger.info('Polling for audio challenge...');
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                // Check if we have all required elements
                const elements = await frame.evaluate(() => {
                    const audioContainer = document.querySelector('#rc-audio');
                    if (!audioContainer || !audioContainer.offsetParent) return null;

                    const audioSource = document.querySelector('#audio-source');
                    const downloadLink = document.querySelector('.rc-audiochallenge-tdownload-link');
                    const responseInput = document.querySelector('#audio-response');
                    
                    if (!audioSource || !downloadLink || !responseInput) return null;
                    if (!audioSource.src) return null;
                    
                    // Check if elements are actually visible
                    const downloadLinkVisible = downloadLink.offsetParent !== null;
                    const responseInputVisible = responseInput.offsetParent !== null;
                    
                    if (!downloadLinkVisible || !responseInputVisible) return null;

                    return {
                        audioUrl: audioSource.src
                    };
                });

                if (elements) {
                    logger.info('Challenge elements found');
                    return elements.audioUrl;
                }

            } catch (evalError) {
                if (!evalError.message.includes('Execution context was destroyed') && !evalError.message.includes('Attempted to use detached Frame')) {
                    logger.error(`Evaluation error: ${evalError.message}`);
                }
                return null;
            }

            // Wait a bit before next attempt
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        logger.warn(`Challenge elements not found after ${maxAttempts} attempts`);
        
        // Log frame content for debugging
        try {
            const html = await frame.content();
            logger.warn(`Current frame HTML: ${html.substring(0, 500) + '...'}`);
        } catch (e) {
            logger.error(`Could not get frame content: ${e.message}`);
        }
        
        return null;

    } catch (error) {
        logger.error(`Error in waitForAudioChallenge: ${error.message}`);
        return null;
    }
}

async function checkForBlockingMessage(frame, maxAttempts = 20) {
    try {
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                // Check for blocking message
                const message = await frame.$('.rc-doscaptcha-header-text');
                if (message) {
                    const isVisible = await frame.evaluate(el => {
                        const style = window.getComputedStyle(el);
                        return style.display !== 'none' && style.visibility !== 'hidden';
                    }, message);

                    if (isVisible) {
                        const messageText = await frame.evaluate(el => el.textContent, message);
                        if (messageText.includes('Try again later')) {
                            return true;
                        }
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                if (!error.message.includes('Execution context was destroyed') && !error.message.includes('Attempted to use detached Frame')) {
                    return false;
                }
            }
        }
        return false;
    } catch (error) {
        return false;
    }
}


async function solveCaptchaChallenge(page, wit) {
    function rdn(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min)) + min;
    }

    try {
        const alertHandler = async dialog => {
            const message = dialog.message();
            logger.warn(`Alert detected: ${message}`);
            if (message.includes('Cannot contact reCAPTCHA')) {
                logger.warn('Detected reCAPTCHA connection error, moving on...');
                await dialog.accept();
                return null;
            }
            await dialog.accept();
        };
        
        page.on('dialog', alertHandler);

        // Use the new frame detection method
        const captchaElements = await findCaptchaFrame(page);
        if (!captchaElements) {
            logger.error('Failed to find captcha elements');
            return null;
        }

        // Click the checkbox
        await new Promise(resolve => setTimeout(resolve, 500 + Math.floor(Math.random() * 1000)));
        await captchaElements.checkbox.click();
        logger.info('Clicked checkbox');

        // Race between getting immediate token or challenge opening
        const checkboxResult = await Promise.race([
            waitForToken(page).then(token => token ? { type: 'token', token } : null),
            waitForChallengeFrame(page).then(frame => frame ? { type: 'challenge', frame } : null)
        ]);

        if (!checkboxResult) {
            // Take screenshot with timestamp
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            await page.screenshot({ 
                path: `test_screenshots/captcha_error_${timestamp}.png`,
                fullPage: true 
            });
            logger.error('Neither token nor challenge appeared');
            return null;
        }

        // If we got a token, we're done!
        if (checkboxResult.type === 'token') {
            logger.info('Solved without challenge!');
            return checkboxResult.token;
        }

        // Otherwise, we got a challenge frame - proceed with audio challenge
        const bframe = checkboxResult.frame;
        
        // Double check we don't have a token before proceeding with audio
        const immediateToken = await waitForToken(page, 10); // Quick check with fewer attempts
        if (immediateToken) {
            logger.info('Got token before starting audio challenge');
            return immediateToken;
        }

        logger.info('Challenge opened, proceeding with audio');

        // Audio challenge loop - try up to 3 times
        let audioAttempts = 0;
        const maxAudioAttempts = 3;
        let isBlocked = false;

        while (audioAttempts < maxAudioAttempts && !isBlocked) {
            audioAttempts++;
            if (audioAttempts > 1) {
                logger.warn(`[Audio] Attempt ${audioAttempts}/${maxAudioAttempts}`);
            }

            try {
                // If this is not the first attempt, we're already in audio challenge
                // Just wait for the new audio to be ready
                if (audioAttempts === 1) {
                    // First attempt - need to click audio button
                    try {
                        // Wait for audio button and ensure it's clickable
                        await bframe.waitForFunction(
                            () => {
                                const button = document.querySelector('#recaptcha-audio-button');
                                if (!button || !button.offsetParent) return false;
                                
                                const style = window.getComputedStyle(button);
                                return style.display !== 'none' && 
                                       style.visibility !== 'hidden' && 
                                       button.offsetWidth > 0 && 
                                       button.offsetHeight > 0;
                            },
                            { timeout: 10000 }
                        );

                        // Get a fresh reference to the button after we know it's ready
                        const audioButton = await bframe.$('#recaptcha-audio-button');
                        if (!audioButton) {
                            logger.warn('[Captcha] Audio button not found after waiting');
                            continue;
                        }

                        // Ensure button is in viewport
                        await bframe.evaluate(() => {
                            const button = document.querySelector('#recaptcha-audio-button');
                            if (button) {
                                button.scrollIntoView({ block: 'center', inline: 'center' });
                            }
                        });

                        // Small delay to ensure any scrolling is complete
                        await new Promise(resolve => setTimeout(resolve, 500));

                        // Click the button
                        await audioButton.click({ delay: rdn(30, 150) });
                        logger.info('Clicked audio button');

                    } catch (error) {
                        logger.error(`Error clicking audio button: ${error.message}`);
                        continue;
                    }
                }

                // Race between audio challenge appearing and blocking message
                const audioResult = await Promise.race([
                    waitForAudioChallenge(bframe).then(audioUrl => {
                        if (audioUrl) return { type: 'audio', url: audioUrl };
                        return null;
                    }),
                    checkForBlockingMessage(bframe).then(blocked => blocked ? { type: 'blocked' } : null)
                ]);

                if (!audioResult) {
                    logger.warn('[Captcha] Neither audio challenge nor blocking message appeared');
                    continue; // Try again
                }

                if (audioResult.type === 'blocked') {
                    logger.warn('[Captcha] Got blocked after clicking audio button');
                    isBlocked = true;
                    return null;
                }

                logger.info(`Got audio URL: ${audioResult.url.slice(0, 50) + '...'}`);

                const transcription = await downloadAndTranscribeAudio(audioResult.url, wit);
                if (!transcription) {
                    logger.warn('[Captcha] Failed to get transcription, retrying...');
                    const reloadButton = await bframe.$('#recaptcha-reload-button');
                    await reloadButton.click({ delay: rdn(30, 150) });
                    continue; // Try again
                }

                // Enter transcription and verify
                const input = await bframe.$('#audio-response');
                await input.click({ delay: rdn(30, 150) });
                await input.type(transcription, { delay: rdn(30, 75) });

                const verifyButton = await bframe.$('#recaptcha-verify-button');
                await verifyButton.click({ delay: rdn(30, 150) });

                // Race between possible outcomes after verification
                const verifyResult = await Promise.race([
                    waitForToken(page).then(token => token ? { type: 'token', token } : null),
                    checkForFailedChallenge(bframe).then(failed => failed ? { type: 'needMore' } : null),
                    checkForBlockingMessage(bframe).then(blocked => blocked ? { type: 'blocked' } : null)
                ]);

                if (!verifyResult) {
                    logger.warn('[Captcha] No result after verification, retrying...');
                    continue;
                }

                if (verifyResult.type === 'token') {
                    logger.info('Solution found!');
                    return verifyResult.token;
                }

                if (verifyResult.type === 'blocked') {
                    logger.warn('[Captcha] Got blocked after verification');
                    isBlocked = true;
                    return null;
                }

                if (verifyResult.type === 'needMore') {
                    logger.warn('[Captcha] Multiple solutions required, continuing...');
                    continue;
                }

            } catch (error) {
                logger.error(`Error in attempt: ${error.message}`);
                continue; // Try again on error
            }
        }

        logger.error(`Failed after ${maxAudioAttempts} attempts`);
        return null;

    } catch (error) {
        logger.error(`Fatal error in solveCaptcha: ${error}`);
        return null;
    }
}

// Add this function to handle directory deletion
async function cleanupUserDataDirs(baseDir) {
    try {
        logger.info('Cleaning up previous Chrome user data...');
        
        // Create the base directory if it doesn't exist
        try {
            await fs.mkdir(baseDir, { recursive: true });
        } catch (err) {
            if (err.code !== 'EEXIST') {
                logger.error(`Error creating base directory: ${err.message}`);
                return;
            }
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

async function generateCaptchaTokensWithAudio({
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
        userDataDir: path.join(os.tmpdir(), 'recaptcha-solver-audio-chrome-data'),
        userAgents: [
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    },

    // Proxy settings
    proxy = {
        enabled: false,
        host: null,
        port: null,
        username: null,
        password: null
    },

    // Update wit.ai configuration
    wit = {
        apiKeys: []
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

    // Filter the API keys here instead
    const validWitKeys = wit.apiKeys.filter(Boolean);
    if (!validWitKeys || validWitKeys.length === 0) {
        throw new Error('At least one Wit.ai API key is required');
    }

    // Update wit config with filtered keys
    wit.apiKeys = validWitKeys;

    // Convert proxy config to internal format if enabled
    const proxyConfig = proxy.enabled ? {
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password
    } : null;

    logger.info('\n=== Starting Token Generation ===');
    logger.info(`Concurrent Browsers: ${concurrentBrowsers}`);
    logger.info(`Tabs per Browser: ${tabsPerBrowser}`);
    logger.info(`Captcha URL: ${captchaUrl}`);
    logger.info('=========================================');

    const resultTracker = new ResultTracker();
    const activeBrowsers = new Set();
    let tokensGenerated = 0;
    let shouldContinue = true;

    // Use provided user agents or fall back to default array
    const defaultUserAgents = [
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ];

    const activeUserAgents = browser.userAgents || defaultUserAgents;

    while (shouldContinue && tokensGenerated < tokensToGenerate) {
        try {
            while (activeBrowsers.size < concurrentBrowsers) {
                try {
                    logger.info(`[Debug] Active browsers: ${activeBrowsers.size}/${concurrentBrowsers}`);

                    // Get a random available user data directory
                    let userDataDir;
                    let attempts = 0;
                    const maxAttempts = 20;  // Prevent infinite loop

                    while (attempts < maxAttempts) {
                        const randomNum = Math.floor(Math.random() * MAX_USER_DATA_DIRS) + 1;
                        const testDir = `${browser.userDataDir}/chrome-user-data-${randomNum}`;
                        if (!userDataDirs.has(testDir)) {
                            userDataDir = testDir;
                            break;
                        }
                        attempts++;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }

                    if (!userDataDir) {
                        logger.error('[Browser] No available user data directories');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    }

                    const browserInstance = await launchBrowser(
                        userDataDir, 
                        proxyConfig, 
                        browser.headless, 
                        activeUserAgents,
                        browser
                    );
                    logger.info(`\n[Browser] Launching with directory ${userDataDir}`);

                    const browserPromise = (async () => {
                        try {
                            const pages = await browserInstance.pages();
                            const page = pages[0];
                            
                            try {
                                await page.goto(captchaUrl, {
                                    waitUntil: 'networkidle2',
                                    timeout: 120000
                                });

                                const token = await solveCaptchaChallenge(page, wit);
                                
                                if (token) {
                                    eventEmitter.emit('tokenGenerated', { token });
                                    resultTracker.addResult({ success: true });
                                    tokensGenerated++;
                                    
                                    if (tokensGenerated >= tokensToGenerate) {
                                        shouldContinue = false;
                                    }
                                } else {
                                    resultTracker.addResult({ success: false });
                                }

                            } catch (error) {
                                logger.error('\nError generating token:', error.message, '\n');
                                eventEmitter.emit('tokenError', { error: error.message });
                                resultTracker.addResult({ success: false });
                            }

                        } finally {
                            logger.info(`\n[Browser] Closing browser...`);
                            await browserInstance.cleanup();
                            activeBrowsers.delete(browserInstance);
                        }
                    })();

                    activeBrowsers.add(browserInstance);
                    browserPromise.catch(error => {
                        logger.error(`Error in browser: ${error}`);
                        browserInstance.cleanup().catch(logger.error);
                        activeBrowsers.delete(browserInstance);
                    });

                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (error) {
                    logger.error(`Error launching browser: ${error.message}`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            logger.error(`Error in main loop: ${error}`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    if (tokensGenerated >= tokensToGenerate) {
        logger.info(`Target of ${tokensToGenerate} tokens reached`);
    }
}

module.exports = generateCaptchaTokensWithAudio;

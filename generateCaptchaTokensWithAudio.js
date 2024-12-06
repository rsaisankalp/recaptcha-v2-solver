const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const clc = require('cli-color');
const undici = require('undici');
const EventEmitter = require('events');

dotenv.config();

// Configuration
const CONCURRENT_BROWSERS = 6;
const TABS_PER_BROWSER = 1;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ALLOW_PROXY = false;
const osPlatform = os.platform();
const executablePath = osPlatform.startsWith('win') 
    ? "C://Program Files//Google//Chrome//Application//chrome.exe" 
    : "/usr/bin/google-chrome";

const BROWSER_CLEANUP_DELAY = 400; // ms to wait after browser closes
const userDataDirs = new Set(); // Track which user data dirs are in use
const MAX_USER_DATA_DIRS = 15;  // Pool of 10 possible directories
const MAX_ATTEMPTS_BEFORE_RESTART = 200; // After this many attempts, do a full restart

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
        if (stats) {
            console.log(clc.cyan(`CAPTCHA Stats: `) + 
                       clc.green(`${stats.successRate}% Success`) + ` | ` + 
                       clc.cyan(`${stats.avgTimePerToken}s/token`) + ` | ` + 
                       clc.yellow(`${stats.totalAttempts} Attempts`) + ` | ` + 
                       clc.green(`${stats.successfulTokens} Tokens`));
        }
    }
}

// Browser management functions
async function launchBrowser(userDataDir) {
    userDataDirs.add(userDataDir);
    const proxyUrl = `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
    const randomProfile = Math.floor(Math.random() * 4) + 1;

    try {
        const browser = await puppeteerExtra.launch({
            headless: true,
           // executablePath: executablePath,
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
                '--lang=en',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-web-security',
                '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end',
                `--profile-directory=Profile ${randomProfile}`,
                ALLOW_PROXY ? `--proxy-server=${proxyUrl}` : ''
            ].filter(Boolean),
            ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
            defaultViewport: null,
        });

        // Update page configuration with request interception
        browser.on('targetcreated', async (target) => {
            const page = await target.page();
            if (page) {
                await page.evaluateOnNewDocument(() => {
                    Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                    delete navigator.__proto__.webdriver;
                });
                
                const userAgents = [
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                ];
                const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
                await page.setUserAgent(USER_AGENT);
                
                await page.setDefaultTimeout(30000);
                await page.setDefaultNavigationTimeout(30000);

      

             
            }
        });

        // Add cleanup function to browser
        browser.cleanup = async () => {
            try {
                await browser.close();
            } catch (error) {
                console.error(clc.red('[Browser] Error closing browser:', error.message));
            }
            
            // Wait before releasing the user data dir
            await new Promise(resolve => setTimeout(resolve, BROWSER_CLEANUP_DELAY));
            userDataDirs.delete(userDataDir);
        };

        return browser;
    } catch (error) {
        // If browser launch fails, release the user data dir
        userDataDirs.delete(userDataDir);
        throw error;
    }
}


// Add audio transcription function
async function downloadAndTranscribeAudio(audioUrl) {
    try {
        let audioData;
        let downloadAttempts = 0;
        const maxDownloadAttempts = 3;
        
        while (downloadAttempts < maxDownloadAttempts) {
            try {
                downloadAttempts++;
                console.log(clc.cyan(`[Audio] Download attempt ${downloadAttempts}/${maxDownloadAttempts}`));
                
                const audioResponse = await axios.get(audioUrl, {
                    responseType: 'arraybuffer',
                    validateStatus: false,
                    timeout: 60000
                });

                if (audioResponse.status !== 200) {
                    throw new Error(`Failed to download audio: ${audioResponse.status}`);
                }

                audioData = audioResponse.data;
                console.log(clc.green('[Audio] Downloaded successfully'));
                break;

            } catch (downloadError) {
                console.error(clc.red(`[Audio] Download attempt ${downloadAttempts} failed:`), downloadError.message);
                if (downloadAttempts === maxDownloadAttempts) return null;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const witTokens = [
            process.env.WIT_TOKEN,
            process.env.WIT_TOKEN_1,
            process.env.WIT_TOKEN_2
        ].filter(Boolean);
        
        const witToken = witTokens[Math.floor(Math.random() * witTokens.length)];

        console.log(clc.cyan('[Audio] Transcribing with wit.ai...'));
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
            console.error(clc.red('[Audio] No transcription found'));
            return null;
        }

        const lastText = lastTextMatch[lastTextMatch.length - 1];
        const audioTranscript = lastText.match(/"text":\s*"([^"]+)"/)[1];
        console.log(clc.green('[Audio] Transcribed text:'), clc.yellow(audioTranscript));

        return audioTranscript;

    } catch (error) {
        console.error(clc.red('[Audio] Error in transcription:'), error);
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
        
        console.log(clc.cyan('[Captcha] Found anchor frame'));

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
            console.log(clc.red('[Captcha] Checkbox found but not clickable'));
            return null;
        }

        // Ensure checkbox is in viewport
        await frame.evaluate(() => {
            const checkbox = document.querySelector('.recaptcha-checkbox-border');
            if (checkbox) {
                checkbox.scrollIntoView({ block: 'center', inline: 'center' });
            }
        });

        console.log(clc.green('[Captcha] Checkbox is ready'));
        return { frame, checkbox };

    } catch (error) {
        console.error(clc.red('[Captcha] Error finding captcha:'), error.message);
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
                    console.log(clc.green('[Token] Token found'));
                    return token;
                }

            } catch (evalError) {
                if (!evalError.message.includes('Execution context was destroyed') && !evalError.message.includes('Attempted to use detached Frame')  && !evalError.message.includes('Target closed')) {
                    console.error(clc.red('[Token] Evaluation error:'), evalError.message);
                }
                return null;
            }

            // Wait a bit before next attempt
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return null;

    } catch (error) {
        console.error(clc.red('[Token] Error in waitForToken:'), error.message);
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

        console.log(clc.green('[Challenge] Challenge frame ready'));
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
            console.log(clc.yellow('[Challenge] Challenge frame did not appear within timeout'));
        } else {
            console.error(clc.red('[Challenge] Error waiting for challenge frame:'), error.message);
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
        console.log(clc.cyan('[Audio] Polling for audio challenge...'));
        
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
                    console.log(clc.green('[Audio] Challenge elements found'));
                    return elements.audioUrl;
                }

            } catch (evalError) {
                if (!evalError.message.includes('Execution context was destroyed') && !evalError.message.includes('Attempted to use detached Frame')) {
                    console.error(clc.red('[Audio] Evaluation error:'), evalError.message);
                }
                return null;
            }

            // Wait a bit before next attempt
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log(clc.yellow('[Audio] Challenge elements not found after', maxAttempts, 'attempts'));
        
        // Log frame content for debugging
        try {
            const html = await frame.content();
            console.log(clc.yellow('[Audio] Current frame HTML:'), html.substring(0, 500) + '...');
        } catch (e) {
            console.log(clc.red('[Audio] Could not get frame content:', e.message));
        }
        
        return null;

    } catch (error) {
        console.error(clc.red('[Audio] Error in waitForAudioChallenge:'), error.message);
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


async function solveCaptchaChallenge(page) {
    function rdn(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min)) + min;
    }

    try {
        const alertHandler = async dialog => {
            const message = dialog.message();
            console.log(clc.yellow('[Captcha] Alert detected:'), message);
            if (message.includes('Cannot contact reCAPTCHA')) {
                console.log(clc.yellow('[Captcha] Detected reCAPTCHA connection error, moving on...'));
                await dialog.accept();
                return null;
            }
            await dialog.accept();
        };
        
        page.on('dialog', alertHandler);

        // Use the new frame detection method
        const captchaElements = await findCaptchaFrame(page);
        if (!captchaElements) {
            console.log(clc.red('[Captcha] Failed to find captcha elements'));
            return null;
        }

        // Click the checkbox
        await new Promise(resolve => setTimeout(resolve, 500 + Math.floor(Math.random() * 1000)));
        await captchaElements.checkbox.click();
        console.log(clc.green('[Captcha] Clicked checkbox'));

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
            console.log(clc.red('[Captcha] Neither token nor challenge appeared'));
            return null;
        }

        // If we got a token, we're done!
        if (checkboxResult.type === 'token') {
            console.log(clc.green('[Captcha] Solved without challenge!'));
            return checkboxResult.token;
        }

        // Otherwise, we got a challenge frame - proceed with audio challenge
        const bframe = checkboxResult.frame;
        
        // Double check we don't have a token before proceeding with audio
        const immediateToken = await waitForToken(page, 10); // Quick check with fewer attempts
        if (immediateToken) {
            console.log(clc.green('[Captcha] Got token before starting audio challenge'));
            return immediateToken;
        }

        console.log(clc.green('[Captcha] Challenge opened, proceeding with audio'));

        // Audio challenge loop - try up to 3 times
        let audioAttempts = 0;
        const maxAudioAttempts = 3;
        let isBlocked = false;

        while (audioAttempts < maxAudioAttempts && !isBlocked) {
            audioAttempts++;
            if (audioAttempts > 1) {
                console.log(clc.yellow(`[Audio] Attempt ${audioAttempts}/${maxAudioAttempts}`));
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
                            console.log(clc.red('[Captcha] Audio button not found after waiting'));
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
                        console.log(clc.green('[Captcha] Clicked audio button'));

                    } catch (error) {
                        console.error(clc.red('[Captcha] Error clicking audio button:'), error.message);
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
                    console.log(clc.red('[Captcha] Neither audio challenge nor blocking message appeared'));
                    continue; // Try again
                }

                if (audioResult.type === 'blocked') {
                    console.log(clc.yellow('[Captcha] Got blocked after clicking audio button'));
                    isBlocked = true;
                    return null;
                }

                console.log(clc.green('[Captcha] Got audio URL:'), clc.yellow(audioResult.url.slice(0, 50) + '...'));

                const transcription = await downloadAndTranscribeAudio(audioResult.url);
                if (!transcription) {
                    console.log(clc.red('[Captcha] Failed to get transcription, retrying...'));
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
                    console.log(clc.red('[Captcha] No result after verification, retrying...'));
                    continue;
                }

                if (verifyResult.type === 'token') {
                    console.log(clc.green('[Captcha] Solution found!'));
                    return verifyResult.token;
                }

                if (verifyResult.type === 'blocked') {
                    console.log(clc.yellow('[Captcha] Got blocked after verification'));
                    isBlocked = true;
                    return null;
                }

                if (verifyResult.type === 'needMore') {
                    console.log(clc.yellow('[Captcha] Multiple solutions required, continuing...'));
                    continue;
                }

            } catch (error) {
                console.error(clc.red('[Audio] Error in attempt:'), error.message);
                continue; // Try again on error
            }
        }

        console.log(clc.red(`[Audio] Failed after ${maxAudioAttempts} attempts`));
        return null;

    } catch (error) {
        console.error(clc.red('[Captcha] Fatal error in solveCaptcha:'), error);
        return null;
    }
}
//TODO :don't make this run forever, isntead run in batche,s after that close all browsers, close puppeteer fully,  clear any user data folder
 async function generateCaptchaTokens({
    eventEmitter,
    concurrentBrowsers = CONCURRENT_BROWSERS,
    tabsPerBrowser = TABS_PER_BROWSER,
    captchaUrl = 'https://www.google.com/recaptcha/api2/demo'
} = {}) {
    if (!eventEmitter) {
        throw new Error('eventEmitter is required');
    }
    console.log(clc.cyan('\n=== Starting Token Generation ==='));
    console.log(clc.white('Concurrent Browsers:'), clc.yellow(concurrentBrowsers));
    console.log(clc.white('Tabs per Browser:'), clc.yellow(tabsPerBrowser));
    console.log(clc.white('Captcha URL:'), clc.yellow(captchaUrl));
    console.log('=========================================\n');

    const resultTracker = new ResultTracker();
    const activeBrowsers = new Set();
    let totalAttempts = 0;  // Changed from totalTokensGenerated

    // Add a flag to track if restart is in progress
    let isRestartInProgress = false;

    const performFullRestart = async () => {
        if (isRestartInProgress) {
            console.log(clc.yellow('[Debug] Restart already in progress, skipping...'));
            return;
        }
        
        isRestartInProgress = true;
        console.log(clc.yellow(`\n[System] Made ${totalAttempts} attempts, initiating graceful shutdown...`));
        
        // Stop launching new browsers/operations
        console.log(clc.cyan('[System] Waiting for current operations to complete...'));
        
        // Force cleanup any stuck browsers after timeout
        const maxWaitTime = 30000; // 30 seconds
        const startWait = Date.now();
        
        // Wait for active browsers to finish their current tasks
        while (activeBrowsers.size > 0) {
            console.log(clc.cyan(`[System] Waiting for ${activeBrowsers.size} browsers to finish...`));
            
            // Add timeout to prevent infinite waiting
            if (Date.now() - startWait > maxWaitTime) {
                console.log(clc.red('[System] Timeout waiting for browsers, forcing cleanup...'));
                // Force close all remaining browsers
                const closePromises = Array.from(activeBrowsers).map(browser => browser.cleanup());
                await Promise.all(closePromises);
                activeBrowsers.clear();
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Now perform the actual restart
        console.log(clc.yellow('[System] All browsers finished, performing cleanup...'));
        
        // Clear user data directories
        userDataDirs.clear();
        
        // Delete chrome user data folders
        const userDataBasePath = './chrome-user-data';
        try {
            if (fs.existsSync(userDataBasePath)) {
                console.log(clc.cyan('[System] Cleaning up Chrome user data...'));
                fs.rmSync(userDataBasePath, { recursive: true, force: true });
            }
        } catch (error) {
            console.error(clc.red('[System] Error cleaning up Chrome user data:', error.message));
        }
        
        totalAttempts = 0;  // Reset attempts counter instead of tokens
        console.log(clc.green('[System] Restart complete, continuing token generation'));
        await new Promise(resolve => setTimeout(resolve, 3000));
        isRestartInProgress = false;
    };

    // Modify the shouldRestart function
    const shouldRestart = async () => {
        if (isRestartInProgress) return true;
        if (totalAttempts >= MAX_ATTEMPTS_BEFORE_RESTART) {
            console.log(clc.yellow(`[Debug] Restart needed at ${totalAttempts} attempts`));
            performFullRestart().catch(error => {
                console.error(clc.red('[System] Error during restart:', error));
                isRestartInProgress = false;
            });
            return true;
        }
        return false;
    };

    while (true) {
        try {
            // Skip the browser spawning loop entirely if restart is in progress
            if (isRestartInProgress) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            // Check if we need to restart
            if (totalAttempts >= MAX_ATTEMPTS_BEFORE_RESTART) {
                await performFullRestart();
                continue;
            }

            while (activeBrowsers.size < concurrentBrowsers && !isRestartInProgress) {
                try {
                    console.log(clc.cyan(`[Debug] Active browsers: ${activeBrowsers.size}/${concurrentBrowsers}`));
                    
                    // Check again before launching a new browser
                    if (await shouldRestart()) continue;

                    // Get a random available user data directory
                    let userDataDir;
                    let attempts = 0;
                    const maxAttempts = 20;  // Prevent infinite loop

                    while (attempts < maxAttempts) {
                        const randomNum = Math.floor(Math.random() * MAX_USER_DATA_DIRS) + 1;
                        const testDir = `./chrome-user-data/chrome-user-data-${randomNum}`;
                        if (!userDataDirs.has(testDir)) {
                            userDataDir = testDir;
                            break;
                        }
                        attempts++;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }

                    if (!userDataDir) {
                        console.error(clc.red('[Browser] No available user data directories'));
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    }

                    const browser = await launchBrowser(userDataDir);
                    console.log(clc.cyan(`\n[Browser] Launching with directory ${userDataDir}`));

                    const browserPromise = (async () => {
                        try {
                            const pages = await browser.pages();
                            const page = pages[0];
                            
                            try {
                                // Check before starting a new token generation
                                if (await shouldRestart()) return;

                                await page.goto(captchaUrl, {
                                    waitUntil: 'networkidle2',
                                    timeout: 120000
                                });

                                const token = await solveCaptchaChallenge(page);
                                
                                if (token) {
                                    eventEmitter.emit('tokenGenerated', { token });
                                    
                                    if (!isRestartInProgress) {
                                        resultTracker.addResult({ success: true });
                                        resultTracker.printStats();
                                        totalAttempts++;  // Increment attempts regardless of success
                                        console.log(clc.cyan(`[System] Total attempts: ${totalAttempts}/${MAX_ATTEMPTS_BEFORE_RESTART}`));
                                        
                                        // Trigger restart if needed
                                        if (totalAttempts >= MAX_ATTEMPTS_BEFORE_RESTART && !isRestartInProgress) {
                                            console.log(clc.red(`[Debug] Attempt threshold reached, triggering restart`));
                                            performFullRestart().catch(error => {
                                                console.error(clc.red('[System] Error during restart:', error));
                                                isRestartInProgress = false;
                                            });
                                        }
                                    } else {
                                        console.log(clc.yellow('[Debug] Token emitted but stats skipped due to restart in progress'));
                                        await new Promise(resolve => setTimeout(resolve, 2000));
                                    }
                                } else {
                                    resultTracker.addResult({ success: false });
                                    totalAttempts++;  // Increment attempts on failure too
                                }

                            } catch (error) {
                                console.error(clc.red('\nError generating token:', error.message, '\n'));
                                eventEmitter.emit('tokenError', { error: error.message });
                                resultTracker.addResult({ success: false });
                                totalAttempts++;  // Increment attempts on error too
                            }

                        } finally {
                            console.log(clc.yellow(`\n[Browser] Closing browser...`));
                            await browser.cleanup();
                            activeBrowsers.delete(browser);
                        }
                    })();

                    activeBrowsers.add(browser);
                    browserPromise.catch(error => {
                        console.error(clc.red('Error in browser:', error));
                        browser.cleanup().catch(console.error);
                        activeBrowsers.delete(browser);
                    });

                    await new Promise(resolve => setTimeout(resolve, 2000));
                } catch (error) {
                    console.error(clc.red('Error launching browser:', error.message));
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            console.error(clc.red('Error in main loop:', error));
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

// Update exports and main execution
if (require.main === module) {
    const eventEmitter = new EventEmitter();
    const resultTracker = new ResultTracker();

    // Set up event listeners
    eventEmitter.on('tokenGenerated', (data) => {
        console.log(clc.green('\nToken generated:'));
        console.log(clc.yellow(data.token.slice(0, 50) + '...\n'));
        resultTracker.addResult({ success: true });
        resultTracker.printStats();
    });

    eventEmitter.on('tokenError', (data) => {
        console.log(clc.red('\nError generating token:', data.error, '\n'));
        resultTracker.addResult({ success: false });
    });
    
    // Use default values by passing just the required eventEmitter
    generateCaptchaTokens({ eventEmitter }).catch(error => {
        console.error('Fatal error in token generation:', error);
    });
} else {
    module.exports = generateCaptchaTokens;
}

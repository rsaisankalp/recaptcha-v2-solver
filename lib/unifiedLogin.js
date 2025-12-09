require('dotenv').config();
const EventEmitter = require('events');
const generateCaptchaTokensWithVisual = require('./generateCaptchaTokensWithVisual');
const path = require('path');

/**
 * Performs login to VVMVP using visual captcha solving.
 * Returns a Promise that resolves to the Puppeteer Page object (with active session).
 */
const unifiedLogin = async () => {
    return new Promise((resolve, reject) => {
        const eventEmitter = new EventEmitter();
        console.log('[UnifiedLogin] Starting login process...');
        
        // Timeout safety (5 minutes)
        const timeout = setTimeout(() => {
            if (!resolved) {
                console.error('[UnifiedLogin] Timed out.');
                reject(new Error('UnifiedLogin timed out after 5 minutes'));
            }
        }, 5 * 60 * 1000);

        let resolved = false;

        const cleanup = () => {
            clearTimeout(timeout);
        };

        generateCaptchaTokensWithVisual({
            eventEmitter,
            captchaUrl: 'https://ekamblr.vvmvp.org/ekam/index.php/signin',
            browser: {
                headless: false, // Visual solving often requires headful for rendering/screenshots
                userDataDir: path.resolve(__dirname, '../custom-chrome-data'),
                // Let puppeteer find the executable, or define it via env var if needed
                executablePath: process.env.CHROME_BIN || undefined,
                userAgents: [
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                ],
            },
            gemini: {
                apiKey: process.env.GEMINI_API_KEY,
            },
            logger: {
                level: 'info'
            },
            
            onTokenGenerated: async (token, page) => {
                console.log('\n✅ [UnifiedLogin] reCAPTCHA solved. Attempting login...');
                
                try {
                    const userInputSelector = 'input[name="email_address"]';
                    const passwordInputSelector = 'input[name="password"]';
                    const loginButtonSelector = 'button[type="submit"]';

                    await page.waitForSelector(userInputSelector, { visible: true, timeout: 10000 });
                    await page.waitForSelector(passwordInputSelector, { visible: true, timeout: 10000 });
                    
                    console.log('[UnifiedLogin] Typing credentials...');
                    await page.type(userInputSelector, 'nationalevents@vvmvp.org', { delay: 100 });
                    await new Promise(r => setTimeout(r, 500));
                    await page.type(passwordInputSelector, 'nateve111', { delay: 100 });
                    await new Promise(r => setTimeout(r, 1000));
                    
                    console.log('[UnifiedLogin] Submitting form...');
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 30000 }), 
                        page.click(loginButtonSelector),
                    ]);

                    console.log(`[UnifiedLogin] URL after login: ${page.url()}`);

                    // Check for session cookie
                    const cookies = await page.cookies();
                    const sessionCookie = cookies.find(cookie => cookie.name.includes('PHPSESSID'));

                    if (sessionCookie) {
                        console.log('[UnifiedLogin] Login successful. Session cookie found.');
                        resolved = true;
                        cleanup();
                        resolve(page); // Transfer ownership of the page to the caller
                    } else {
                        console.error('[UnifiedLogin] PHPSESSID cookie not found after login.');
                        // Log cookies for debugging
                        console.log('Cookies found:', JSON.stringify(cookies, null, 2));
                        throw new Error('Login failed: PHPSESSID cookie not found.');
                    }

                } catch (error) {
                    console.error('[UnifiedLogin] Error during login actions:', error);
                    if (!resolved) {
                        resolved = true; // prevent further actions
                        cleanup();
                        reject(error);
                        // We must close the browser here because we are rejecting
                        try { await page.browser().close(); } catch(e) {}
                    }
                }
            }
        }).catch(err => {
            console.error('[UnifiedLogin] generateCaptchaTokensWithVisual failed:', err);
            if (!resolved) {
                resolved = true;
                cleanup();
                reject(err);
            }
        });

        eventEmitter.on('tokenError', (data) => {
             console.error('[UnifiedLogin] Token Error:', data);
             if (!resolved) {
                 resolved = true;
                 cleanup();
                 reject(new Error(data.error || 'Token generation failed'));
                 // Try to close browser if we can access it? 
                 // We don't have reference to 'page' or 'browser' here easily unless we stored it from somewhere else.
                 // But generateCaptchaTokensWithVisual might leave it open if we provided onTokenGenerated.
                 // This is a potential leak if generateCaptchaTokensWithVisual doesn't close it on error when callback is present.
                 // But we can't fix it here easily without refactoring the library.
                 // We rely on the timeout or manual cleanup.
             }
        });
    });
};

module.exports = unifiedLogin;

// ENSURE THIS IS THE CONTENT OF: examples/exampleVvmvp.js

require('dotenv').config();

const EventEmitter = require('events');
const generateCaptchaTokensWithVisual = require('../lib/generateCaptchaTokensWithVisual');

const testEventsPage = async (page) => {
    console.log('\n[DEBUG] Testing cookie with a data fetch...');
    const testUrl = 'https://ekamblr.vvmvp.org/ekam/index.php/events/report/event/load/all/all/20250101/20250102/1';
    console.log(`   - Navigating to: ${testUrl}`);

    await page.goto(testUrl, { waitUntil: 'networkidle0' });

    console.log(`[DEBUG] Current URL after test navigation: ${page.url()}`);

    const pageContent = await page.content();
    if (pageContent.includes('<title>Login - VVMVP-EKAM</title>')) {
        console.log('   - ❌ FAILED: Session is invalid, redirected to login page.');
    } else {
        console.log('   - ✅ SUCCESS: Cookie is valid, accessed page content.');
        const tableRegex = /<table border=1>([\s\S]*?)<\/table>/i;
        const tableMatch = pageContent.match(tableRegex);
        if (tableMatch) {
            console.log('   - ✅ Found the events table on the page.');
        } else {
            console.log('   - ❌ Could not find the events table on the page.');
        }
    }
};

const unifiedLogin = async () => {
    const eventEmitter = new EventEmitter();
    console.log('[DEBUG] Starting unified login process...');

    await generateCaptchaTokensWithVisual({
        eventEmitter,
        captchaUrl: 'https://ekamblr.vvmvp.org/ekam/index.php/signin',
        browser: {
            headless: false,
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            userDataDir: './chrome-data', // We need a place to store browser data
            userAgents: [
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ],
        },
        gemini: {
            apiKey: process.env.GEMINI_API_KEY,
        },
        logger: {
            level: 'info'
        },
        
        onTokenGenerated: async (token, page) => {
            console.log('\n✅ [DEBUG] reCAPTCHA solved. Handing control to login script...');
            console.log(`   - Received Token: ${token.substring(0, 30)}...`);
            
            try {
                console.log('   - Pausing for 2 seconds to ensure page is ready...');
                await new Promise(r => setTimeout(r, 2000));

                const userInputSelector = 'input[name="email_address"]';
                const passwordInputSelector = 'input[name="password"]';
                const loginButtonSelector = 'button[type="submit"]';

                console.log(`[DEBUG] Waiting for form field: User ('${userInputSelector}')`);
                await page.waitForSelector(userInputSelector, { visible: true });
                console.log('   - User field is visible.');
                
                console.log(`[DEBUG] Waiting for form field: Password ('${passwordInputSelector}')`);
                await page.waitForSelector(passwordInputSelector, { visible: true });
                console.log('   - Password field is visible.');
                
                console.log('\n[DEBUG] Typing username...');
                await page.type(userInputSelector, 'REPLACE_EMAIL', { delay: 100 });
                console.log('   - Username entered.');

                console.log('   - Pausing for 1 second...');
                await new Promise(r => setTimeout(r, 1000));
                
                console.log('[DEBUG] Typing password...');
                await page.type(passwordInputSelector, 'REPLACE_PASS', { delay: 100 });
                console.log('   - Password entered.');
                
                console.log('   - Pausing for 2 seconds before clicking Login...');
                await new Promise(r => setTimeout(r, 2000));
                
                console.log('[DEBUG] Clicking the login button...');
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }), 
                    page.click(loginButtonSelector),
                ]);
                console.log('   - Login submitted and page navigation complete.');

                console.log(`[DEBUG] Current URL after login: ${page.url()}`);

                console.log('\n[DEBUG] Login complete. Extracting cookies...');
                const cookies = await page.cookies();
                
                console.log('[DEBUG] All cookies found on page:');
                console.log(JSON.stringify(cookies, null, 2));

                const sessionCookie = cookies.find(cookie => cookie.name.includes('PHPSESSID'));

                if (sessionCookie) {
                    const cookiePair = `${sessionCookie.name}=${sessionCookie.value}`;
                    console.log('\n✅✅✅ ---- SUCCESS! ---- ✅✅✅');
                    console.log(`Using session cookie: ${cookiePair}`);
                    console.log('---------------------------------');

                    await testEventsPage(page);
                } else {
                    console.log('\n❌❌❌ ---- FAILED ---- ❌❌❌');
                    console.log('Could not find PHPSESSID cookie after login. Please check credentials or for an error on the page.');
                    console.log('---------------------------');
                }

            } catch (error) {
                console.error('An error occurred during the login automation step:', error);
            } finally {
                console.log('[DEBUG] Login script finished. Closing browser.');
                await page.browser().close();
            }
        }
    });
};

if (require.main === module) {
    unifiedLogin().catch(console.error);
}

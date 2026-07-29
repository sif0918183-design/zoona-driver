import os
from playwright.sync_api import sync_playwright

def run():
    print("Starting verification of passenger_app/index.html...")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 400, 'height': 800},
            is_mobile=True,
            has_touch=True,
            locale='ar-SA'
        )
        page = context.new_page()

        # Navigate to the login page
        page.goto('http://localhost:8080/passenger_app/index.html')

        # Wait a bit
        page.wait_for_timeout(1000)

        # Force splash screen to hide
        page.evaluate("document.getElementById('splash-screen').classList.add('hide');")

        # Wait for rendering
        page.wait_for_timeout(1000)

        # Take a screenshot
        os.makedirs('/home/jules/verification', exist_ok=True)
        screenshot_path = '/home/jules/verification/login_form.png'
        page.screenshot(path=screenshot_path)
        print(f"Screenshot taken and saved to {screenshot_path}")

        browser.close()

if __name__ == "__main__":
    run()

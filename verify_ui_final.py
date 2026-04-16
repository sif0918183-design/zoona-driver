import os
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 400, 'height': 1200},
            is_mobile=True,
            has_touch=True,
            locale='ar-SA'
        )

        # Passenger App
        page = context.new_page()
        page.goto('http://localhost:8080/passenger_app/travel-platform.html')
        page.evaluate("""
            document.getElementById('atp-from').textContent = 'الخرطوم';
            document.getElementById('atp-to').textContent = 'مدني';
            document.getElementById('atp-category').textContent = 'تراكا توفير';
            document.getElementById('atp-price').textContent = '5,000 ج';
            document.getElementById('atp-status').textContent = 'تم اختيار السائق';
            document.getElementById('atp-contact-name').textContent = 'محمد أحمد | تويوتا كورولا';
            document.getElementById('atp-contact-phone').textContent = '0123456789';
            const modal = document.getElementById('active-trip-modal');
            modal.classList.remove('hidden');
            modal.style.display = 'flex';
            modal.style.opacity = '1';
            document.getElementById('atp-cancel-section').style.display = 'block';
            toggleCancelDetails(true);
        """)
        os.makedirs('./verification', exist_ok=True)
        page.wait_for_selector('#atp-cancel-details:not(.hidden)')
        page.wait_for_timeout(500)
        page.screenshot(path='./verification/passenger_final.png')

        browser.close()

if __name__ == "__main__":
    run()

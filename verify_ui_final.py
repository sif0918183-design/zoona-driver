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

        page = context.new_page()

        # Log browser console logs
        page.on('console', lambda msg: print(f"Browser Console: {msg.text}"))

        # Intercept and mock /api/supabase-config API request
        page.route("**/api/supabase-config", lambda route: route.fulfill(
            status=200,
            content_type="application/javascript",
            body="window.SB_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co'; window.SB_KEY = 'mock_anon_key';"
        ))

        # Combined Supabase Database routing to prevent routing order collisions
        def handle_supabase_rest(route):
            url = route.request.url
            if "customers?select" in url:
                route.fulfill(
                    status=200,
                    headers={
                        "content-type": "application/json",
                        "content-range": "0-0/1"
                    },
                    body='{"id": "11111111-1111-1111-1111-111111111111", "full_name": "محمد أحمد", "phone": "0912345678", "is_verified": true}'
                )
            elif "cities" in url:
                route.fulfill(
                    status=200,
                    headers={"content-type": "application/json"},
                    body='[{"name_ar": "الخرطوم"}, {"name_ar": "مدني"}]'
                )
            elif "vehicle_categories" in url:
                route.fulfill(
                    status=200,
                    headers={"content-type": "application/json"},
                    body='[{"id": "1", "name_ar": "تراكا توفير", "price_multiplier": 1.0}]'
                )
            else:
                route.fulfill(
                    status=200,
                    headers={"content-type": "application/json"},
                    body='[]'
                )

        page.route("**/rest/v1/**", handle_supabase_rest)

        # Inject initialization scripts to setup localstorage
        page.add_init_script("""
            localStorage.setItem('tarhal_customer', JSON.stringify({
                id: '11111111-1111-1111-1111-111111111111',
                full_name: 'محمد أحمد',
                phone: '0912345678',
                is_verified: true
            }));
            localStorage.setItem('user_app_choice', 'passenger');
        """)

        # Go to Travel Platform page
        page.goto('http://localhost:8080/passenger_app/travel-platform.html')

        # Wait for travel platform to initialize
        page.wait_for_timeout(2000)

        # Print presence of elements
        print("Is Modal present?", page.evaluate("!!document.getElementById('active-trip-modal')"))
        print("Is atp-from present?", page.evaluate("!!document.getElementById('atp-from')"))

        # Populate active trip data inside UI
        page.evaluate("""
            document.getElementById('atp-from').textContent = 'الخرطوم';
            document.getElementById('atp-to').textContent = 'مدني';
            document.getElementById('atp-category').textContent = 'تراكا توفير';
            document.getElementById('atp-price').textContent = '5,000 ج';
            document.getElementById('atp-status').textContent = 'تم اختيار السائق';
            document.getElementById('atp-contact-name').textContent = 'محمد أحمد | تويوتا كورولا';
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

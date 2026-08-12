import statistics
import time

import app as app_module


ENDPOINTS = (
    "/",
    "/api/events?view=summary&limit=40&offset=0",
    "/api/quotations?view=summary&limit=40&offset=0&sort=updated",
    "/api/clients",
    "/api/finance/departments",
    "/api/finance/salespeople",
    "/api/assets",
    "/api/events/143/workforce",
)

app_module.app.config["TESTING"] = True
client = app_module.app.test_client()
with client.session_transaction() as session:
    session["user"] = "admin"
    session["is_admin"] = True
    session["role"] = "owner"
    session["has_sales_access"] = True
    session["company_code"] = "AVPL"

for endpoint in ENDPOINTS:
    samples = []
    sizes = []
    status = None
    for _ in range(4):
        started = time.perf_counter()
        response = client.get(endpoint)
        samples.append((time.perf_counter() - started) * 1000)
        sizes.append(len(response.data))
        status = response.status_code
    print(
        f"{status:3} {endpoint:70} "
        f"first={samples[0]:8.1f}ms warm_med={statistics.median(samples[1:]):8.1f}ms "
        f"size={max(sizes) / 1024:8.1f}KB"
    )

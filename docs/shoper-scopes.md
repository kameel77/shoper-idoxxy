# Uprawnienia Aplikacji (Scopes) - Shoper x iDoxxy

Podczas procesu konfiguracji integracji oraz w zgłoszeniu aplikacji do App Store Shoper, należy wskazać poniższe uprawnienia i zakresy dostępu do API, wraz z uzasadnieniem ich biznesowego wykorzystania w integracji.

| Obszar API | Wymagane Scopes | Uzasadnienie biznesowe |
| :--- | :--- | :--- |
| **Klienci** | `read_customers` | Wymagane do pobierania podstawowych danych klientów (np. e-mail, imię, nazwisko) po założeniu przez nich konta w sklepie. Dane są synchronizowane z iDoxxy do przypisania klientów do grup trwałych w systemie (np. akceptacja regulaminu na trwałym nośniku). |
| **Zamówienia** | `read_orders` | Wymagane do powiązania danych osoby kupującej z konkretnym zamówieniem, aby zautomatyzować wydanie dokumentów iDoxxy powiązanych z zamówieniem w ramach trwałego nośnika (np. wysyłka regulaminu i wzoru odstąpienia po złożeniu zamówienia). |
| **Webhooki** | `read_webhooks`, `write_webhooks` | Wymagane, by bezpiecznie subskrybować się na zdarzenia (m.in. `customer.created`, `order.created`). Aplikacja nasłuchuje zdarzeń i asynchronicznie przesyła je do iDoxxy, nie obciążając głównego żądania w panelu sklepowym. |
| **Integracje (Offline)** | `read_users` (Offline access) | Zapewnienie stałego i bezpiecznego tokenu autoryzacji (Access/Refresh Token) do operacji w tle, gwarantujących dostarczalność regulaminów na trwałym nośniku, nawet gdy administrator nie jest zalogowany do panelu sklepu. |

> **Uwaga dla operatora:** Zestawienie to powinno zostać dołączone jako załącznik do wniosku o publikację integracji iDoxxy w Shoper App Store.

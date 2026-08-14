# Uprawnienia Aplikacji (Scopes) - Shoper x iDoxxy

Podczas procesu konfiguracji integracji oraz w zgłoszeniu aplikacji do App Store Shoper, należy wskazać poniższe uprawnienia i zakresy dostępu do API, wraz z uzasadnieniem ich biznesowego wykorzystania w integracji.

> **Format nazw.** Dokumentacja Shopera (`developers.shoper.pl/docs`, sekcja *Scopes*) definiuje wzorzec `{zasób}_{akcja}`, gdzie akcją jest `read`, `create`, `edit` albo `delete` — np. `orders_read`, `products_create`. Wcześniejsza wersja tego dokumentu używała odwrotnej kolejności (`read_orders`), niezgodnej z tym wzorcem. Poniżej nazwy w formacie dokumentacyjnym.

| Obszar API | Wymagane Scopes | Uzasadnienie biznesowe |
| :--- | :--- | :--- |
| **Klienci** | `clients_read` | Wymagane do pobierania podstawowych danych klientów (np. e-mail, imię, nazwisko) po założeniu przez nich konta w sklepie. Dane są synchronizowane z iDoxxy do przypisania klientów do grup trwałych w systemie (np. akceptacja regulaminu na trwałym nośniku). |
| **Zamówienia** | `orders_read` | Wymagane do powiązania danych osoby kupującej z konkretnym zamówieniem, aby zautomatyzować wydanie dokumentów iDoxxy powiązanych z zamówieniem w ramach trwałego nośnika (np. wysyłka regulaminu i wzoru odstąpienia po złożeniu zamówienia). |
| **Webhooki** | `webhooks_read`, `webhooks_create` | Wymagane, by subskrybować zdarzenia sklepu (`client.create`, `order.paid`). Aplikacja nasłuchuje zdarzeń i asynchronicznie przesyła je do iDoxxy, nie obciążając głównego żądania w panelu sklepowym. `webhooks_edit` / `webhooks_delete` tylko wtedy, gdy aplikacja ma sama zarządzać cyklem życia webhooków. |

## Do zweryfikowania przed zgłoszeniem

1. **Nazwa zasobu klientów.** Dokumentacja Shopera w jednym miejscu wymienia `users_read` / `users_delete`, a w innym `clients_read` / `clients_delete` dla tych samych danych klientów. Potwierdzić właściwą nazwę w panelu partnera przy definiowaniu scope'ów aplikacji — panel podpowiada listę modułów.

2. **Dostęp offline nie jest osobnym uprawnieniem.** Wcześniejsza wersja dokumentu wymieniała `read_users (Offline access)` jako sposób na stały token. W bieżącej dokumentacji nie ma takiego scope'a — trwałość dostępu zapewnia sam przepływ OAuth 2.0 Authorization Code: `access_token` ważny 90 dni, `refresh_token` 180 dni, odświeżany bez udziału administratora. Uwaga: refresh token jest jednorazowy, każde odświeżenie unieważnia poprzednią parę.

3. **Nazwy zdarzeń webhooków.** W panelu sklepu zdarzenia nazywają się `client.create` i `order.paid`. Wartości `customer.created` / `order.created` występujące w kodzie wtyczki to jej wewnętrzny słownik mapowań i nie mają odpowiednika po stronie Shopera — routing idzie po ścieżce URL webhooka, nie po nazwie zdarzenia.

## Zasada minimalnego zakresu

Dokumentacja Shopera wprost prosi o zamawianie wyłącznie tych uprawnień, których aplikacja faktycznie używa — właściciel sklepu widzi pełną listę na ekranie zgody. Wtyczka nie zapisuje ani nie modyfikuje danych w sklepie, więc żaden scope `create` / `edit` / `delete` na klientach i zamówieniach nie jest potrzebny. Szerszy zakres obniża konwersję na ekranie zgody i wydłuża review.

> **Uwaga dla operatora:** Zestawienie to powinno zostać dołączone jako załącznik do wniosku o publikację integracji iDoxxy w Shoper App Store.

Źródło formatu i listy akcji: dokumentacja Shoper API Docs, sekcja *Scopes* (`https://developers.shoper.pl/docs/`).

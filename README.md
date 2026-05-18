# TransMilenio Explorer 🚌

![TransMilenio Explorer Mockup](./assets/mockup.png)

## Overview
**TransMilenio Explorer** is a high-performance, premium web application designed to visualize and explore the TransMilenio and SITP transit network in Bogotá, Colombia. It provides a real-time-like experience for checking routes, station layouts, and wagon distributions using an interactive map interface.

This project is built with a modern tech stack (Vite + Node.js) and features a robust proxy system to interface with transit data while maintaining high performance and data integrity.

---

## ⚡ Key Features

- **Interactive Transit Map**: Full visualization of Bogotá's transit arteries using high-fidelity map layers.
- **Route Tracking**: Real-time path highlighting for Troncal (Red) and Zonal (Blue) services.
- **Station & Wagon Intelligence**: Deep-dive into station layouts, identifying which services stop at specific wagons (vagones).
- **Advanced Search**: Instant filtering of routes by code (e.g., G47, B12, 661).
- **Catalog Synchronization**: A sophisticated backend scraper that caches and organizes official data into a searchable master catalog.
- **Premium UI**: Dark-mode primary interface with glassmorphism effects and smooth micro-animations.

---

## 🛠️ Architecture & Tech Stack

### Frontend (Client)
- **Framework**: [Vite](https://vitejs.dev/) + TypeScript
- **Styling**: Vanilla CSS (Premium custom design system)
- **Mapping Engine**: Mapbox GL JS / MapLibre (depending on configuration)
- **State Management**: Reactive UI with TypeScript services

### Backend (Server)
- **Runtime**: [Node.js](https://nodejs.org/) + Express + TypeScript
- **Data Layers**: Custom scraping services for `api.buscador-rutas.transmilenio.gov.co`.
- **Caching**: Local JSON-based master catalog with automatic stale-check and background sync.

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [npm](https://www.npmjs.com/)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/estebantorrg/transmilenio.git
   cd transmilenio
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment:**
   - Create `.env` files in both `client/` and `server/` using the provided `.env.example` templates.

4. **Run in development:**
   ```bash
   npm run dev
   ```

---

## ⚖️ Legal Disclaimer & Data Notice

> [!IMPORTANT]
> **READ CAREFULLY:** This project is provided "as is" and is intended for **educational and informational purposes only**.

### 1. Ownership & Affiliation
This application is an **independent, non-official project** developed by **Esteban**. It is **not** affiliated, associated, authorized, endorsed by, or in any way officially connected with **TransMilenio S.A.**, the Mayor's Office of Bogotá, or any of their subsidiaries or affiliates.

### 2. Data Source & Trademarks
- **Data**: All transit data, including route names, station codes, and geographic coordinates, is fetched from publicly accessible endpoints of the official TransMilenio mobile application infrastructure.
- **Intellectual Property**: The name "TransMilenio", as well as all logos and related branding, are registered trademarks of TransMilenio S.A. No claim is made to the ownership of any transit data or official trademarks.
- **Scrubbing & Proxying**: This tool uses a proxy-based approach to fetch data. The developer is not responsible for any misuse of the data or for any actions taken by the data provider in response to the use of this software.

### 3. Liability
The developer assumes no responsibility for:
- Accuracy or availability of transit data.
- Disruptions in service.
- Any legal implications arising from the scraping or redistribution of the transit data.

Users are encouraged to use the [official TransMilenio website](https://www.transmilenio.gov.co) for official travel planning.

---

## 📄 License

This project's code is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for the full text.

**Copyright (c) 2026 Esteban.** All Rights Reserved.

---

## 🤝 Credits
Developed with ❤️ for the city of Bogotá by **Esteban**.

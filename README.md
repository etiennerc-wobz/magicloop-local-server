# magicLoop-local-server

This repository contains 4 separate Node.js applications that are part of the MagicLoop Cup Rental POCs. Each application represents a different version or iteration of the system.
See Google Drive documentation for more information. https://drive.google.com/drive/folders/1_L7nclxP7-oBY7WCLuj8pUvFmQxxzGGm?usp=drive_link

The 4 POCs (Proof of Concepts) are aimed at providing an interface for cup rentals within the MagicLoop system. The applications are as follows:

1. **v1-stripe/v1-local-server.js**: This application is the first version of the system, and it integrates with the Stripe payment gateway.

2. **v2-cashless/v2-local-server.js**: The second version of the system, which is the V3 implementation but with a dummy payment.

3. **v3-caisse/v3-local-server.js**: The third version of the system, which includes a Stripe payment functionality.

4. **v4-weenloopDashboard/v4-app.js**: The fourth version of the system, which provides a dashboard for the WeenLoop platform.

Each application is contained within its own folder, and the main entry point for each application is the file indicated in the list above.

## Getting Started

To get started with the project, follow these steps:

1. Clone the repository to your local machine.
2. Navigate to the folder of the specific POC you want to run (e.g., `v1-stripe`).
3. Install the required dependencies by running `npm install` in the terminal.
4. Start the application by running `nmp start` (or `node server.js`  (replace server.js by the file name for the POC you're running)).
5. The application should now be running on the address displayed in the CLI.

## Folder Structure

The repository is structured as follows:

```
magicLoop-local-server/
├── v1-stripe/
│   └── v1-local-server.js
├── v2-cashless/
│   └── v2-local-server.js
├── v3-caisse/
│   └── v3-local-server.js
└── v4-weenloopDashboard/
    └── v4-app.js
```

Each folder contains the necessary files and code for the corresponding POC, with the main entry point being the file indicated in the list above.


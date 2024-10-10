# Magic Loop Dashboard
_POC Code name: v4-weenloopDashboard_

This repository contains the fourth version of the Magic Loop Local Server POC system, which provides a dashboard for the WeenLoop platform.

The Magic Loop Dashboard requires the Magic Loop API to run. You can configure your dashboard to interact with a production version of the API or a local version of the API.
The API is only used as a data source, i.e. the Dashboard never uses the API to POST, PUT, DELETE or PATCH data, only to GET data.

See [Google Drive documentation](https://drive.google.com/drive/folders/1_L7nclxP7-oBY7WCLuj8pUvFmQxxzGGm?usp=drive_link) for more information. 

## Getting Started

### Install the application

If it's the first time that you install the application, follow these steps:

Before starting, you need `git`, `nvm` and `make`. Use your own commands or follow all or part of these steps to proceed:

```
# Update packages list
sudo apt-get update

# Download and install nvm
# See https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating for troubleshooting with nvm install
# Install CURL
sudo apt-get install curl
# Use CURL to install donwload and install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Install git
sudo apt-get install git-all

# Install Node 20 with nvm
nvm install 20

# Install make
sudo apt-get install make
```

Then follow these steps:

1. Clone the git repository to your local machine.
2. Navigate to the v4 folder with `cd v4-weenloopDashboard`.
3. Run `nvm use`.
4. Install the required dependencies by running `make init` in the terminal.
5. Modify the .env file and add appropriate secrets to connect to the API. You can also change the API base URL in the .env if you want to use a non-production version of the API.
6. Create the local DB structure by running `node initDB.js`
7. Start the application by running `make` or `make run`.
8. The application should now be running on the address displayed in the CLI.

### Run the application on a local platform (i.e. your computer)

If project is already installed, next time you want to use it, you have to follow these steps.

1. Navigate to the folder `v4-weenloopDashboard` with `cd v4-weenloopDashboard`.
2. Start the application by running `nvm use && make` or `nvm use && make run`.
3. The application should now be running on the address displayed in the CLI.

### Run the application as a service

To run the application as a service, you need to configure your service to use the appropriate version of NodeJS and run the application with `npm systemd`.

### Stop the application

While running in the Terminal, you can stop and exit the application by useing `CTRL + c`. If you still have a web browser with the front application running,
it will likely display an error message.

### Update the application

If you want to run an updated version of the project, you should ensure that your DB version is the correct one. As there are no migration features for now, the
simplest solution is to drop then re-init the database. To do that, follow these steps:

1. Navigate to the v4 folder with `cd v4-weenloopDashboard`.
2. Drop the DB by running `node dropDB.js`
3. Create the local DB structure by running `node initDB.js`

## Folder Structure

The repository is structured as follows:

```
magicLoop-local-server/
└── ...
└── v4-weenloopDashboard/
    └── node_modules
    └── public
    └── views
    └── ...
    └── v4-app.js
```

## Languages, frameworks and libraries

The Magic Loop Dashboard is written with JavaScript, HTML and CSS.

Backend framework used is [NodeJS](https://nodejs.org).

Frontend framework used is [Express](https://expressjs.com).

Database Management System used is [SQLite](https://www.sqlite.org).


Some of the libraries used are:
* Bootstrap
* JQuery
* Select2
* Fontawesome
* ChartJS
* Refreshless noUiSlider
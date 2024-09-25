# Default action
.DEFAULT_GOAL := run

# Variables
MAKE = make
NPM = npm
PORT = 3000
URL = http://localhost:$(PORT_API_CDESK)
DIR = ./
ENV_FILE = .env
ENV_DEV_FILE = .env.dev
PATH_TO_ENV_FILE = $(DIR)$(ENV_FILE)
PATH_TO_ENV_DEV_FILE = $(DIR)$(ENV_DEV_FILE)

# Does not print directory change
MAKEFLAGS += --no-print-directory

# Default = silent unless VERBOSE is specified
.PHONY:
ifndef VERBOSE
.SILENT:
endif

## —— 🔥 App ——
run:
	$(NPM) start

create-env:
	cp $(PATH_TO_ENV_DEV_FILE) $(PATH_TO_ENV_FILE)
	echo "Environment file $(ENV_FILE) was modified. You can modify it at your needs."

init: ## Init the project
ifneq ("$(wildcard $(PATH_TO_ENV_FILE))","")
	echo "Environment file $(ENV_FILE) already exists. You can modify it at your needs."
else
	$(MAKE) create-env
endif
	$(MAKE) npm-install

npm-install:
	$(NPM) i
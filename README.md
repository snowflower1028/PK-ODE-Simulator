# 🧪 PK Simulator Web App

A fully interactive web application for simulating pharmacokinetic (PK) profiles from custom ODE systems. Built with **Django + Bootstrap + JavaScript (Plotly)**. Designed for researchers, students, and pharmacometricians.

---

## 🔧 Features

- ✍️ **Custom ODE System** input (e.g., `dCdt = -kel*C`)
- ⚙️ Initial values & parameter definition (auto-detected from equations)
- 💉 **Flexible Dosing** interface
  - IV Bolus / Infusion
  - Repeat dosing schedule
- ⏱️ Simulation controls (time range, resolution)
- 📊 **Interactive Plot** (Plotly-based)
  - Y-axis log scale toggle
  - Auto-highlight selected compartments
- 📈 **PK Parameter Summary Table**
  - `Cmax`, `Tmax`, `AUC` per compartment
- 📂 **Observed Data Upload**
  - CSV upload of external measurements
  - Overlay as dots on simulation chart

---

## 📁 File Structure

```
simulator/
├── templates/
│   └── index.html         # Main HTML with Bootstrap UI
├── static/
│   └── simulator/js/
│       └── dosing.js      # Full simulation logic and dynamic UI
├── views.py               # Handles simulation request and returns results
├── solver.py              # Equation parser and numerical solver
```

---

## How to Run Locally

This project uses Python and Django. A local setup requires a virtual environment and environment variables for security.

### 1\. Clone the Repository

```bash
git clone https://github.com/snowflower1028/PK-ODE-Simulator.git
cd PK-ODE-Simulator
```

### 2\. Set Up a Virtual Environment

It's highly recommended to use a virtual environment to manage project dependencies.

```bash
# Create a virtual environment
python -m venv .venv

# Activate the virtual environment
# On Windows:
.venv\Scripts\activate
# On macOS/Linux:
source .venv/bin/activate
```

### 3\. Install Dependencies

Install all required packages using the `requirements.txt` file.

```bash
pip install -r requirements.txt
```

### 4\. Create an Environment Variable File (`.env`)

For security, sensitive settings like the `SECRET_KEY` are managed via environment variables. Create a `.env` file in the project's root directory.

```bash
# Create a .env file in the root directory
# For example, using 'copy con .env' on Windows or 'touch .env' on macOS/Linux
```

Add the following content to your `.env` file.

**.env**

```
# For local development, set DEBUG to True
DJANGO_DEBUG=True

# Generate your own secret key. Do not use a key exposed on GitHub.
DJANGO_SECRET_KEY='your-new-secret-key-goes-here'
```

> **Important**: To generate a new secret key, run the following command in your terminal with the virtual environment activated:
> `python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"`
> Copy the output and paste it as the value for `DJANGO_SECRET_KEY`.

### 5\. Run Database Migrations

Set up the initial database tables required by Django.

```bash
python manage.py migrate
```

### 6\. Run the Development Server

You are now ready to run the application.

```bash
python manage.py runserver
```

Open your web browser and go to **[http://127.0.0.1:8000](https://www.google.com/search?q=http://127.0.0.1:8000)** to see the application running.

---

## 📌 How to Simulate

### 1. Define ODEs
Input your differential equations using the format:
```
dCdt = -kel * C
```

### 2. Set Initial Values & Parameters
Auto-generated based on your ODEs.

### 3. Add Dosing Regimens
- Choose compartment
- Bolus or infusion
- Set amount, timing, and repeat pattern

### 4. Adjust Simulation Settings
Set time range, resolution, and compartments to plot.

### 5. Upload Observed Data *(Optional)*
Upload a `.csv` with columns:
```
Time,A1_obs,A2_obs,...
```

### 6. Run Simulation
Click 🚀 to generate plot and PK summary.

---
## 📌 How to Fit

### 1. Define ODEs
Input your differential equations using the format:
```
dCdt = -kel * C
```

### 2. Set Initial Values & Parameters
Auto-generated based on your ODEs.

### 3. Adjust Simulation Settings
Set time range, resolution, and compartments to plot.

### 4. Upload Observed Data
Upload a `.csv` with columns:
```
Time,A1_obs,A2_obs,...
```

### 5. Press Fit Parameter Button
Click to set the fitting options.

### 6. Set the fitting options.
- Select parameters and boundary (optional) to fit.
- Add dosing group.
- Select the weighting scheme.

### 7. Run fitting
Fitting performed with least-square method.
---

## 📷 Screenshots
![image](https://github.com/user-attachments/assets/930d0871-a9f3-4595-b0a6-bf7bd43693b3)


---

## 📌 TODO (Roadmap)

- Export simulation & PK summary as CSV
- Add units for parameters (e.g., mg, h, L)
- Apply advanced dosing schedule (multiple, infusion, etc..) to fitting. 

---

## 🧑‍💻 Author

**Minsoo Lee**  
College of Pharmacy, Seoul National University  
[Contact](mailto:minsoo.lee@snu.ac.kr)

---

## 📄 License

This project is licensed under the MIT License.

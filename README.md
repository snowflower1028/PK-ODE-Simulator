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

## 🚀 Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/yourname/pk-simulator.git
   cd pk-simulator
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Run the development server:
   ```bash
   python manage.py runserver
   ```

4. Open in browser:
   ```
   http://localhost:8000/
   ```

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

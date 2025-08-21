// --- 데이터 하드코딩 ---
const EXAMPLE_NCA_DATA = {
    "Time (h)": [0.0833, 1.0, 3.0, 5.0, 12.0, 24.0, 72.0, 144.0, 216.0, 288.0, 360.0, 432.0, 504.0],
    "0.5 mg": [0.959, 0.392, 0.0863, 0.0248, null, null, null, null, null, null, null, null, null],
    "1.5 mg": [3.34, 1.41, 0.810, 0.669, 0.268, 0.0489, null, null, null, null, null, null, null],
    "15 mg": [26.6, 26.6, 26.1, 26.4, 25.1, 21.9, 14.1, 6.80, 0.589, 0.0168, null, null, null],
    "50 mg": [103.0, 104.0, 98.7, 91.6, 86.3, 79.2, 61.8, 47.0, 23.4, 11.1, 4.65, 0.0932, 0.0142]
};
const EXAMPLE_NCA_ANSWERS = {
    "0.5 mg": {"lambda_z": 0.737, "t_half": 0.941, "auc_last": 1.21},
    "1.5 mg": {"lambda_z": 0.135, "t_half": 5.133, "auc_last": 11.1},
    "15 mg": {"lambda_z": 0.0417, "t_half": 16.6, "auc_last": 2496},
    "50 mg": {"lambda_z": 0.0402, "t_half": 17.2, "auc_last": 13922}
};

const FIH_DEFAULTS = {
    noael: {
        animal_bw: 3,
        human_bw: 60,
        exp: 1,
        sf: 10
    },
    mabel: {
        ec20_data: [
            { target: 'Binding to CD3', ec20: 150.00 },
            { target: 'Cytokine release (INF-γ)', ec20: 540.30 },
            { target: 'Cytokine release (IL-6)', ec20: 209.20 },
            { target: 'Cytokine release (IL-1β)', ec20: 450.20 },
            { target: 'Cytokine release (TNF-α)', ec20: 360.30 },
            { target: 'T cell proliferation', ec20: 210.00 },
            { target: 'Tumor cell cytotoxicity', ec20: 100.30 }
        ],
        mw: 150000, // g/mol
        kd: 8.6, // nM
        cd3_per_cell: 6.11E+04,
        t_cells_per_L: 1.30E+09,
        human_plasma_vol: 3, // L
        human_cl: 0.041, // L/h/kg
        efficacious_conc: 0.56 // ug/mL
    },
    pk_based: {
        auc_noael: 153.2, // ug*h/mL
        human_cl: 41,     // mL/h/kg
        sf: 10
    }
};

document.addEventListener('DOMContentLoaded', () => {
    initializeNcaAnalyzer();
    initializeFihTutorial();
});


function initializeNcaAnalyzer() {
    // ... (NCA Analyzer Code - No Changes)
    const loadNcaBtn = document.getElementById('load-nca-example-btn');
    const doseSelect = document.getElementById('dose-group-select');
    const ncaPlotDiv = document.getElementById('nca-plot');
    const ncaResultsContainer = document.getElementById('nca-results-container');
    const logScaleToggle = document.getElementById('log-scale-toggle');
    const showNcaAnswerBtn = document.getElementById('show-answer-btn');

    let ncaFullData = null;
    let timeColumnName = '';
    let currentDose = '';
    let timeData = [];
    let concData = [];
    let isNcaPlotInitialized = false;

    loadNcaBtn.addEventListener('click', () => processNcaData(EXAMPLE_NCA_DATA));
    doseSelect.addEventListener('change', handleDoseChange);
    logScaleToggle.addEventListener('change', () => plotNcaData(true));
    showNcaAnswerBtn.addEventListener('click', displayNcaAnswers);

    function processNcaData(data) {
        ncaFullData = data;
        timeColumnName = Object.keys(data)[0];
        const doses = Object.keys(data).filter(k => k !== timeColumnName);
        doseSelect.innerHTML = doses.map(d => `<option value="${d}">${d}</option>`).join('');
        doseSelect.disabled = false;
        showNcaAnswerBtn.disabled = false;
        handleDoseChange();
    }

    function handleDoseChange() {
        currentDose = doseSelect.value;
        if (!currentDose || !ncaFullData) return;
        timeData = [];
        concData = [];
        ncaFullData[timeColumnName].forEach((t, i) => {
            const c = ncaFullData[currentDose][i];
            if (t !== null && !isNaN(t) && c !== null && !isNaN(c)) {
                timeData.push(t);
                concData.push(c);
            }
        });
        plotNcaData(true);
    }
    
    function plotNcaData(resetSelection) {
        document.getElementById('nca-plot-placeholder').style.display = 'none';
        ncaPlotDiv.style.display = 'block';
        const trace = { x: timeData, y: concData, mode: 'lines+markers', type: 'scatter' };
        const layout = { xaxis: { title: timeColumnName }, yaxis: { title: 'Concentration (nM)', type: logScaleToggle.checked ? 'log' : 'linear', autorange: true }, dragmode: 'select', margin: { l: 50, r: 20, t: 20, b: 40 } };
        Plotly.react(ncaPlotDiv, [trace], layout);
        if (!isNcaPlotInitialized) {
            ncaPlotDiv.on('plotly_selected', (eventData) => calculateNCA(eventData));
            ncaPlotDiv.on('plotly_deselect', clearResults);
            isNcaPlotInitialized = true;
        }
        if (resetSelection) clearResults();
    }
    
    function calculateNCA(eventData) {
        const points = eventData?.points;
        if (!points || points.length < 2) {
            clearResults();
            return;
        }
        try {
            const selectedPoints = points.map(p => ({ time: p.x, logConc: Math.log(p.y) }));
            const n = selectedPoints.length;
            const sumX = selectedPoints.reduce((acc, p) => acc + p.time, 0);
            const sumY = selectedPoints.reduce((acc, p) => acc + p.logConc, 0);
            const sumXY = selectedPoints.reduce((acc, p) => acc + p.time * p.logConc, 0);
            const sumX2 = selectedPoints.reduce((acc, p) => acc + p.time * p.time, 0);
            const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
            
            const lambda_z = -slope;
            const t_half = lambda_z > 0 ? Math.LN2 / lambda_z : Infinity;
            
            let auc_last = 0;
            for (let i = 0; i < timeData.length - 1; i++) {
                auc_last += (concData[i] + concData[i+1]) / 2 * (timeData[i+1] - timeData[i]);
            }
            const cmax = Math.max(...concData);
            const tmax = timeData[concData.indexOf(cmax)];

            const c_last = concData[concData.length - 1];
            const t_last = timeData[timeData.length - 1];
            const auc_last_inf = lambda_z > 0 ? c_last / lambda_z : 0;
            const auc_inf = auc_last + auc_last_inf;

            ncaResultsContainer.innerHTML = `
                <div>
                    <h6 class="subsection-title mt-0 pt-0 border-0">주요 PK 파라미터</h6>
                    <dl class="result-grid">
                      <dt>Cmax</dt><dd>${cmax.toFixed(2)} nM</dd>
                      <dt>Tmax</dt><dd>${tmax.toFixed(2)} hr</dd>
                      <dt><strong>$AUC_{last}$</strong></dt><dd><strong>${auc_last.toFixed(2)} nM·hr</strong></dd>
                      <dt><strong>$AUC_{inf}$</strong></dt><dd><strong>${auc_inf.toFixed(2)} nM·hr</strong></dd>
                    </dl>
                </div>
                <div class="mt-4">
                    <h6 class="subsection-title">Terminal Phase 분석 <span class="text-muted small">(${n}개 점 선택됨)</span></h6>
                    <div class="result-formula"><p class="small text-muted mb-1">$ \\lambda_z = - (\\text{ln-linear 기울기}) $</p><dl class="result-grid mb-0"><dt>$ \\lambda_z $</dt><dd>${lambda_z.toFixed(4)} hr⁻¹</dd></dl></div>
                    <div class="result-formula mt-2"><p class="small text-muted mb-1">$ t_{1/2} = \\frac{\\ln(2)}{\\lambda_z} $</p><dl class="result-grid mb-0"><dt>$ t_{1/2} $</dt><dd>${t_half.toFixed(2)} hr</dd></dl></div>
                </div>
                <div class="mt-4">
                    <h6 class="subsection-title">상세 AUC 계산 과정</h6>
                    <div class="table-responsive" style="max-height: 250px;"><table class="table table-sm text-center"><thead class="table-light"><tr><th>Time Interval (h)</th><th>부분 AUC</th><th>누적 AUC</th></tr></thead><tbody>${
                        (() => {
                            let partialAucHtml = '';
                            let cumulativeAuc = 0;
                            for (let i = 0; i < timeData.length - 1; i++) {
                                const partialAuc = (concData[i] + concData[i+1]) / 2 * (timeData[i+1] - timeData[i]);
                                cumulativeAuc += partialAuc;
                                partialAucHtml += `<tr><td>${timeData[i].toFixed(2)} - ${timeData[i+1].toFixed(2)}</td><td>${partialAuc.toFixed(2)}</td><td>${cumulativeAuc.toFixed(2)}</td></tr>`;
                            }
                            partialAucHtml += `<tr><td>${t_last.toFixed(2)} - ∞</td><td>${auc_last_inf.toFixed(2)}</td><td>${auc_inf.toFixed(2)}</td></tr>`;
                            return partialAucHtml;
                        })()
                    }</tbody></table></div>
                </div>`;
            MathJax.typesetPromise([ncaResultsContainer]);
        } catch (error) {
            console.error("Error during NCA calculation:", error);
            ncaResultsContainer.innerHTML = `<div class="alert alert-danger small"><strong>Calculation Error:</strong> ${error.message}</div>`;
        }
    }

    function displayNcaAnswers() {
        const answerData = EXAMPLE_NCA_ANSWERS[currentDose];
        if (!answerData) { alert('현재 용량 그룹에 대한 정답 데이터가 없습니다.'); return; }

        const answerHtml = `<div class="alert alert-info mt-3"><h6 class="alert-heading">정답</h6><ul class="list-unstyled mb-0 small"><li><strong>$ \\lambda_z $:</strong> ${answerData.lambda_z.toFixed(4)} hr⁻¹</li><li><strong>$ t_{1/2} $:</strong> ${answerData.t_half.toFixed(2)} hr</li><li><strong>$AUC_{last}$:</strong> ${answerData.auc_last.toFixed(1)} nM·hr</li></ul></div>`;
        const existingAnswer = ncaResultsContainer.querySelector('.alert-info');
        if (existingAnswer) existingAnswer.remove();
        ncaResultsContainer.insertAdjacentHTML('beforeend', answerHtml);
        MathJax.typesetPromise([ncaResultsContainer]);
    }
}

/**
 * FIH 튜토리얼 관련 모든 기능을 초기화합니다.
 */
function initializeFihTutorial() {
    // --- Initialize Tooltips ---
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl);
    });

    // --- 공통 DOM 요소 ---
    const loadFihBtn = document.getElementById('load-fih-defaults-btn');

    // --- NOAEL Elements ---
    const noaelStartBtn = document.getElementById('noael-start-btn');
    const noaelTutorialContent = document.getElementById('noael-tutorial-content');
    const noaelStep34 = document.getElementById('noael-step-3-4');
    const noaelButtons = document.querySelectorAll('#noael-step-2 button');
    const noaelFeedback = document.getElementById('noael-feedback');
    const noaelFinalResult = document.getElementById('noael-final-result');
    const noaelInputs = {
        noael: document.getElementById('noael-input-noael'),
        bwAnimal: document.getElementById('noael-input-bw-animal'),
        bwHuman: document.getElementById('noael-input-bw-human'),
        exp: document.getElementById('noael-input-exp'),
        sf: document.getElementById('noael-input-sf')
    };

    // --- MABEL Elements ---
    const mabelStartBtn = document.getElementById('mabel-start-btn');
    const mabelTutorialContent = document.getElementById('mabel-tutorial-content');
    const mabelEc20Buttons = document.querySelectorAll('#mabel-step-1 button');
    const mabelFeedbackStep1 = document.getElementById('mabel-feedback-step1');
    const mabelStep2 = document.getElementById('mabel-step-2');
    const mabelStep3 = document.getElementById('mabel-step-3');
    const mabelStep4 = document.getElementById('mabel-step-4');
    const mabelHedTableContainer = document.getElementById('mabel-hed-table-container');
    // Method 1
    const mabelRoM1Ab = document.getElementById('mabel-ro-m1-ab');
    const mabelRoM1Kd = document.getElementById('mabel-ro-m1-kd');
    const mabelRoM1Result = document.getElementById('mabel-ro-m1-result');
    // Method 2
    const mabelRoM2Td = document.getElementById('mabel-ro-m2-td');
    const mabelRoM2Tt = document.getElementById('mabel-ro-m2-tt');
    const mabelRoM2Kd = document.getElementById('mabel-ro-m2-kd');
    const mabelRoM2Result = document.getElementById('mabel-ro-m2-result');
    // In vivo
    const mabelInvivoCl = document.getElementById('mabel-invivo-cl');
    const mabelInvivoCeff = document.getElementById('mabel-invivo-ceff');
    const mabelInvivoResult = document.getElementById('mabel-invivo-result');

    // --- PK-based Elements ---
    const pkBasedStartBtn = document.getElementById('pk-based-start-btn');
    const pkBasedTutorialContent = document.getElementById('pk-based-tutorial-content');
    const pkBasedInputs = {
        auc: document.getElementById('pk-based-auc'),
        cl: document.getElementById('pk-based-cl'),
        sf: document.getElementById('pk-based-sf'),
    };
    const pkBasedResult = document.getElementById('pk-based-result');

    // --- 공통 이벤트 ---
    loadFihBtn.addEventListener('click', loadFihDefaults);

    // --- NOAEL Tutorial Logic ---
    noaelStartBtn.addEventListener('click', function() {
        this.parentElement.style.display = 'none';
        noaelTutorialContent.classList.remove('d-none');
    });

    noaelButtons.forEach(button => {
        button.addEventListener('click', () => {
            const selectedNoael = button.dataset.noael;
            const selectedSpecies = button.dataset.species;
            noaelButtons.forEach(btn => btn.classList.remove('active', 'list-group-item-danger', 'list-group-item-success'));

            if (selectedSpecies === 'Monkey') {
                button.classList.add('active', 'list-group-item-success');
                noaelFeedback.innerHTML = `<div class="alert alert-success small p-2"><strong>정답입니다!</strong> 사람과 가장 계통학적으로 유사한 영장류(Monkey)의 데이터를 사용하는 것이 가장 보수적이고 적절합니다.</div>`;
                noaelInputs.noael.value = selectedNoael;
                noaelStep34.classList.remove('d-none');
                updateNoaelDose();
            } else {
                button.classList.add('list-group-item-danger');
                noaelFeedback.innerHTML = `<div class="alert alert-warning small p-2"><strong>다시 생각해보세요.</strong> 일반적으로 사람과 가장 유사한 동물 종의 데이터를 사용하거나, 여러 종 중 가장 낮은 값(가장 보수적인 값)을 선택합니다.</div>`;
                noaelStep34.classList.add('d-none');
                noaelFinalResult.innerHTML = '';
            }
        });
    });

    Object.values(noaelInputs).forEach(input => input.addEventListener('input', updateNoaelDose));

    function updateNoaelDose() {
        const noael = parseFloat(noaelInputs.noael.value);
        const bwAnimal = parseFloat(noaelInputs.bwAnimal.value);
        const bwHuman = parseFloat(noaelInputs.bwHuman.value);
        const exp = parseFloat(noaelInputs.exp.value);
        const sf = parseFloat(noaelInputs.sf.value);

        if ([noael, bwAnimal, bwHuman, exp, sf].some(isNaN)) {
            noaelFinalResult.innerHTML = ''; return;
        }

        const hed = noael * Math.pow((bwAnimal / bwHuman), 1 - exp);
        const fihDose = hed / sf;

        noaelFinalResult.innerHTML = `<div class="result-formula"><p class="small text-muted mb-1">계산된 HED: $ ${noael.toFixed(2)} \\times (\\frac{${bwAnimal}}{${bwHuman}})^{1-${exp}} = \\mathbf{${hed.toFixed(2)}} \\text{ mg/kg} $</p></div><div class="alert alert-success mt-3"><strong>계산된 FIH Starting Dose: <br> $ \\frac{${hed.toFixed(2)} \\text{ mg/kg}}{${sf}} = \\mathbf{${fihDose.toFixed(2)}} \\text{ mg/kg} $</strong></div>`;
        MathJax.typesetPromise([noaelFinalResult]);
    }

    // --- MABEL Tutorial Logic ---
    mabelStartBtn.addEventListener('click', function() {
        this.parentElement.style.display = 'none';
        mabelTutorialContent.classList.remove('d-none');
    });

    mabelEc20Buttons.forEach(button => {
        button.addEventListener('click', () => {
            const selectedEc20 = parseFloat(button.dataset.ec20);
            mabelEc20Buttons.forEach(btn => btn.classList.remove('active', 'list-group-item-danger', 'list-group-item-success'));
            
            const minEc20 = Math.min(...FIH_DEFAULTS.mabel.ec20_data.map(d => d.ec20));

            if (selectedEc20 === minEc20) {
                button.classList.add('active', 'list-group-item-success');
                mabelFeedbackStep1.innerHTML = `<div class="alert alert-success small p-2"><strong>정답입니다!</strong> MABEL의 정의에 따라 가장 낮은 EC20 값인 <strong>${minEc20.toFixed(2)} ng/mL</strong>를 선택하는 것이 가장 보수적이고 올바른 접근입니다.</div>`;
                displayMabelHedTable(selectedEc20);
                mabelStep2.classList.remove('d-none');
                mabelStep3.classList.remove('d-none');
                mabelStep4.classList.remove('d-none');
            } else {
                button.classList.add('list-group-item-danger');
                mabelFeedbackStep1.innerHTML = `<div class="alert alert-warning small p-2"><strong>다시 생각해보세요.</strong> MABEL은 어떠한 생물학적 효과라도 나타나는 '최저' 농도를 의미합니다.</div>`;
                mabelStep2.classList.add('d-none');
                mabelStep3.classList.add('d-none');
                mabelStep4.classList.add('d-none');
            }
        });
    });
    
    function displayMabelHedTable(selectedEc20) {
        const { ec20_data, human_plasma_vol } = FIH_DEFAULTS.mabel;
        let tableHtml = `<table class="table table-sm table-bordered">
            <thead class="table-light">
                <tr><th>Target</th><th>EC20 (µg/L)</th><th>Dose (µg) for 70kg patient</th><th>Dose (µg) for kg</th></tr>
            </thead>
            <tbody>`;
        
        ec20_data.forEach(item => {
            const ec20_ug_per_L = item.ec20; // ng/mL is equivalent to ug/L
            const dose_ug_70kg = ec20_ug_per_L * human_plasma_vol;
            const dose_ug_per_kg = dose_ug_70kg / 60; // Assuming 60kg patient
            const isSelected = item.ec20 === selectedEc20 ? 'table-success' : '';
            tableHtml += `<tr class="${isSelected}">
                <td>${item.target}</td>
                <td>${ec20_ug_per_L.toFixed(1)}</td>
                <td>${dose_ug_70kg.toFixed(1)}</td>
                <td><strong>${dose_ug_per_kg.toFixed(1)}</strong></td>
            </tr>`;
        });

        tableHtml += `</tbody></table>`;
        mabelHedTableContainer.innerHTML = tableHtml;
    }
    
    [mabelRoM1Ab, mabelRoM1Kd].forEach(el => el.addEventListener('input', updateRoMethod1));
    [mabelRoM2Td, mabelRoM2Tt, mabelRoM2Kd].forEach(el => el.addEventListener('input', updateRoMethod2));
    [mabelInvivoCl, mabelInvivoCeff].forEach(el => el.addEventListener('input', updateInVivoDose));

    function updateRoMethod1() {
        const ab = parseFloat(mabelRoM1Ab.value);
        const kd = parseFloat(mabelRoM1Kd.value);
        if (isNaN(ab) || isNaN(kd) || (ab + kd) === 0) {
            mabelRoM1Result.innerHTML = ''; return;
        }
        const ro = (ab / (ab + kd)) * 100;
        mabelRoM1Result.innerHTML = `<div class="alert alert-secondary mt-2">계산된 %RO: <strong>${ro.toFixed(2)} %</strong></div>`;
    }

    function updateRoMethod2() {
        const td = parseFloat(mabelRoM2Td.value);
        const tt = parseFloat(mabelRoM2Tt.value);
        const kd = parseFloat(mabelRoM2Kd.value);
        if (isNaN(td) || isNaN(tt) || isNaN(kd) || tt === 0) {
            mabelRoM2Result.innerHTML = ''; return;
        }
        const term1 = kd + td + tt;
        const term2 = Math.sqrt(Math.pow(term1, 2) - 4 * td * tt);
        const ro = ((term1 - term2) / (2 * tt)) * 100;
        mabelRoM2Result.innerHTML = `<div class="alert alert-secondary mt-2">계산된 %RO: <strong>${ro.toFixed(2)} %</strong></div>`;
    }

    function updateInVivoDose() {
        const cl = parseFloat(mabelInvivoCl.value);
        const ceff = parseFloat(mabelInvivoCeff.value);
        if (isNaN(cl) || isNaN(ceff)) {
            mabelInvivoResult.innerHTML = ''; return;
        }
        // Dose (mg/day) = CL(L/h/kg) * Ceff(ug/mL -> mg/L) * 24h/day * 60kg
        const dose = cl * ceff * 24 * 60;
        mabelInvivoResult.innerHTML = `<div class="alert alert-secondary mt-2">계산된 용량: <strong>${dose.toFixed(2)} mg/day</strong></div>`;
    }

    // --- PK-based Tutorial Logic ---
    pkBasedStartBtn.addEventListener('click', function() {
        this.parentElement.style.display = 'none';
        pkBasedTutorialContent.classList.remove('d-none');
    });

    Object.values(pkBasedInputs).forEach(input => input.addEventListener('input', updatePkBasedDose));

    function updatePkBasedDose() {
        const auc = parseFloat(pkBasedInputs.auc.value);
        const cl = parseFloat(pkBasedInputs.cl.value);
        const sf = parseFloat(pkBasedInputs.sf.value);

        if ([auc, cl, sf].some(isNaN) || sf === 0) {
            pkBasedResult.innerHTML = '';
            return;
        }
        
        // Dose (mg/kg) = (AUC(ug*h/mL) * CL(mL/h/kg)) / (SF * 1000 ug/mg)
        const dose = (auc * cl) / (sf * 1000);

        pkBasedResult.innerHTML = `
            <div class="alert alert-success">
                <h6 class="alert-heading">계산된 FIH Starting Dose</h6>
                <p class="mb-0"><strong>${dose.toFixed(3)} mg/kg</strong></p>
                <hr>
                <p class="small text-muted mb-0">
                    $ \\frac{${auc} \\times ${cl}}{${sf} \\times 1000} = ${dose.toFixed(3)}\\ mg/kg $
                </p>
            </div>`;
        MathJax.typesetPromise([pkBasedResult]);
    }

    // --- 공통 함수 ---
    function loadFihDefaults() {
        // NOAEL
        noaelInputs.bwAnimal.value = FIH_DEFAULTS.noael.animal_bw;
        noaelInputs.bwHuman.value = FIH_DEFAULTS.noael.human_bw;
        noaelInputs.exp.value = FIH_DEFAULTS.noael.exp;
        noaelInputs.sf.value = FIH_DEFAULTS.noael.sf;
        if (noaelInputs.noael.value) updateNoaelDose();

        // MABEL
        const { mw, kd, cd3_per_cell, t_cells_per_L, human_cl, efficacious_conc } = FIH_DEFAULTS.mabel;
        const minEc20 = Math.min(...FIH_DEFAULTS.mabel.ec20_data.map(d => d.ec20)); // 100.3 ng/mL
        
        // Step 3
        const hed_dose_ug = minEc20 * FIH_DEFAULTS.mabel.human_plasma_vol; // 300.9 ug
        const hed_dose_mg = hed_dose_ug / 1000; // 0.3009 mg
        const total_moles = (hed_dose_mg / 1000) / mw; // moles
        const total_conc_M = total_moles / FIH_DEFAULTS.mabel.human_plasma_vol; // M (mol/L)
        const total_conc_nM = total_conc_M * 1e9; // nM
        
        mabelRoM1Ab.value = total_conc_nM.toFixed(3);
        mabelRoM1Kd.value = kd;
        
        mabelRoM2Td.value = total_conc_nM.toFixed(3);
        mabelRoM2Kd.value = kd;
        
        const avogadro = 6.022e23;
        const total_target_M = (cd3_per_cell * t_cells_per_L) / avogadro;
        const total_target_nM = total_target_M * 1e9;
        mabelRoM2Tt.value = total_target_nM.toFixed(3);
        
        // Step 4
        mabelInvivoCl.value = human_cl;
        mabelInvivoCeff.value = efficacious_conc;
        
         // PK-based
        pkBasedInputs.auc.value = FIH_DEFAULTS.pk_based.auc_noael;
        pkBasedInputs.cl.value = FIH_DEFAULTS.pk_based.human_cl;
        pkBasedInputs.sf.value = FIH_DEFAULTS.pk_based.sf;
        updatePkBasedDose();

        // Trigger calculations
        updateRoMethod1();
        updateRoMethod2();
        updateInVivoDose();

        alert('FIH 예제 데이터 로드 완료!');
    }
}

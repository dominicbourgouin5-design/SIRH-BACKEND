
// tutorialService.js
const supabase = require('./supabaseClient');

async function getAvailableTutorials(role, userId) {
    try {
        const { data: tutorials, error } = await supabase
            .from('tutorials')
            .select('*')
            .eq('is_active', true)
            .or(`role_target.eq.${role},role_target.is.null`);
        
        if (error) throw error;
        
        // Récupérer la progression
        const { data: progress } = await supabase
            .from('user_tutorial_progress')
            .select('*')
            .eq('user_id', userId);
        
        const tutorialsWithProgress = (tutorials || []).map(tutorial => ({
            ...tutorial,
            progress: progress?.find(p => p.tutorial_id === tutorial.id) || {
                current_step: 0,
                completed_steps: [],
                is_completed: false
            }
        }));
        
        return tutorialsWithProgress;
    } catch (error) {
        console.error("Erreur getAvailableTutorials:", error.message);
        return [];
    }
}

async function startTutorial(userId, tutorialId) {
    const { data: existing } = await supabase
        .from('user_tutorial_progress')
        .select('*')
        .eq('user_id', userId)
        .eq('tutorial_id', tutorialId)
        .single();
    
    if (existing) return existing;
    
    const { data, error } = await supabase
        .from('user_tutorial_progress')
        .insert({
            user_id: userId,
            tutorial_id: tutorialId,
            current_step: 0,
            completed_steps: []
        })
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

async function nextStep(userId, tutorialId, currentStep, completedStep) {
    const { data: tutorial } = await supabase
        .from('tutorials')
        .select('steps')
        .eq('id', tutorialId)
        .single();
    
    if (!tutorial) throw new Error('Tutoriel non trouvé');
    
    const steps = tutorial.steps || [];
    const nextStepIndex = currentStep + 1;
    const isCompleted = nextStepIndex >= steps.length;
    
    const { data, error } = await supabase
        .from('user_tutorial_progress')
        .update({
            current_step: nextStepIndex,
            completed_steps: [...(completedStep !== undefined ? [completedStep] : [])],
            is_completed: isCompleted,
            completed_at: isCompleted ? new Date().toISOString() : null
        })
        .eq('user_id', userId)
        .eq('tutorial_id', tutorialId)
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

async function resetTutorial(userId, tutorialId) {
    const { data, error } = await supabase
        .from('user_tutorial_progress')
        .update({
            current_step: 0,
            completed_steps: [],
            is_completed: false,
            completed_at: null
        })
        .eq('user_id', userId)
        .eq('tutorial_id', tutorialId)
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

async function completeTutorial(userId, tutorialId) {
    const { data: tutorial } = await supabase
        .from('tutorials')
        .select('steps')
        .eq('id', tutorialId)
        .single();
    
    const stepsCount = tutorial?.steps?.length || 0;
    const allSteps = Array.from({ length: stepsCount }, (_, i) => i);
    
    const { data, error } = await supabase
        .from('user_tutorial_progress')
        .update({
            current_step: stepsCount,
            completed_steps: allSteps,
            is_completed: true,
            completed_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('tutorial_id', tutorialId)
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

async function shouldShowTutorial(userId, role) {
    const { data: completed } = await supabase
        .from('user_tutorial_progress')
        .select('id')
        .eq('user_id', userId)
        .eq('is_completed', true)
        .limit(1);
    
    if (completed && completed.length > 0) return false;
    return true;
}

module.exports = {
    getAvailableTutorials,
    startTutorial,
    nextStep,
    resetTutorial,
    completeTutorial,
    shouldShowTutorial
};

const createAuthSlice = (set) => ({
    user: null,
    setUser: (userData) => set({user: userData}),
    logout: () => set({user: null}),
});

export default createAuthSlice;

